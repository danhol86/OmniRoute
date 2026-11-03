import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-decisions-transport-"));
const { handleOpenAIDecisions, openaiDecisionsSchema, decisionCost, OPENAI_DECISIONS_URL } =
  await import("../../open-sse/handlers/openaiDecisions.ts");
const { resolveEndpointCategory, resolveCanonicalEndpointPath } =
  await import("../../src/shared/constants/endpointCategories.ts");
const body = {
  model: "openai/gpt-6-luna" as const,
  input: "Test evidence",
  questions: [{ type: "predicate" as const, name: "check", instructions: "Is this evidence?" }],
};
const usage = {
  input_tokens: 100,
  output_tokens: 0,
  total_tokens: 100,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
};
const answer = {
  model: "gpt-6-luna",
  answers: [{ name: "check", type: "predicate", probability: 0.91 }],
  usage,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

for (const model of ["gpt-6-luna", "openai/gpt-6-luna"] as const) {
  test(`native forwarding and fixed destination: ${model}`, async () => {
    const request = {
      ...body,
      model,
      prompt_cache_key: "test",
      input: [{ role: "user", content: [{ type: "input_json", data: { value: true } }] }],
    };
    const response = await handleOpenAIDecisions(
      { body: request, apiKey: "synthetic-provider-key" },
      async (url, options) => {
        assert.equal(url, OPENAI_DECISIONS_URL);
        assert.equal(options.retry, false);
        assert.equal(options.allowRedirect, false);
        assert.equal(options.guard, "public-only");
        assert.equal(options.timeoutMs, 30_000);
        assert.equal(
          new Headers(options.headers).get("Authorization"),
          "Bearer synthetic-provider-key"
        );
        assert.deepEqual(JSON.parse(options.body as string), { ...request, model: "gpt-6-luna" });
        return json(answer);
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), answer);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
}

test("all three question types, distributions and refusals are unchanged", async () => {
  const questions = [
    body.questions[0],
    {
      type: "choice" as const,
      name: "route",
      instructions: "Select",
      choices: [{ value: true }, { value: "true" }],
    },
    {
      type: "score" as const,
      name: "score",
      instructions: "Score",
      levels: [{ label: "low" }, { label: "high" }],
    },
  ];
  const answers = [
    answer.answers[0],
    {
      type: "choice",
      name: "route",
      choice: true,
      probabilities: [
        { value: true, probability: 0.8 },
        { value: "true", probability: 0.2 },
      ],
      confidence: 0.6,
    },
    { type: "refusal", name: "score", reason: "declined" },
  ];
  const result = { ...answer, answers };
  const response = await handleOpenAIDecisions(
    { body: { ...body, questions }, apiKey: "test" },
    async () => json(result)
  );
  assert.deepEqual(await response.json(), result);
});

for (const status of [400, 401, 403, 429, 500, 503, 302]) {
  test(`HTTP ${status} is not replayed and does not leak upstream data`, async () => {
    let calls = 0;
    const response = await handleOpenAIDecisions({ body, apiKey: "synthetic-secret" }, async () => {
      calls++;
      return new Response("synthetic-secret private-evidence /home/operator", {
        status,
        headers: { "Retry-After": "12" },
      });
    });
    assert.equal(calls, 1);
    assert.equal(response.status, status === 302 ? 502 : status);
    assert.equal(response.headers.get("Retry-After"), "12");
    assert.doesNotMatch(await response.text(), /synthetic-secret|private-evidence|\/home/);
  });
}

for (const invalid of [
  {},
  { ...answer, answers: [] },
  { ...answer, usage: { input_tokens: -1 } },
]) {
  test(`malformed upstream success fails closed: ${JSON.stringify(invalid).slice(0, 35)}`, async () => {
    const response = await handleOpenAIDecisions({ body, apiKey: "test" }, async () =>
      json(invalid)
    );
    assert.equal(response.status, 502);
  });
}

test("non-JSON success is not passed through", async () => {
  const response = await handleOpenAIDecisions(
    { body, apiKey: "test" },
    async () => new Response("<html>private</html>")
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private/);
});

test("oversized upstream success is bounded", async () => {
  const response = await handleOpenAIDecisions(
    { body, apiKey: "test" },
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1))
  );
  assert.equal(response.status, 502);
});

test("aborted request makes no upstream call", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const response = await handleOpenAIDecisions(
    { body, apiKey: "test", signal: controller.signal },
    async () => {
      calls++;
      return json(answer);
    }
  );
  assert.equal(response.status, 499);
  assert.equal(calls, 0);
});

test("transport errors cannot disclose secrets or stack", async () => {
  const response = await handleOpenAIDecisions({ body, apiKey: "test" }, async () => {
    throw new Error("private token at /home/operator");
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private|token|\/home|Error:/);
});

test("schema rejects missing/malformed model ids and malformed questions", () => {
  assert.equal(openaiDecisionsSchema.safeParse(body).success, true);
  for (const invalid of [
    { ...body, model: "https://arbitrary.example?secret=x" },
    { ...body, model: undefined },
    { ...body, questions: [] },
    { ...body, questions: Array(401).fill(body.questions[0]) },
    { ...body, questions: [{ type: "predicate" }] },
    { ...body, input: {} },
  ]) {
    assert.equal(openaiDecisionsSchema.safeParse(invalid).success, false);
  }
});

test("endpoint category covers both gateway spellings", () => {
  for (const pathname of ["/v1/decisions", "/api/v1/decisions"]) {
    assert.equal(resolveEndpointCategory(resolveCanonicalEndpointPath(pathname)), "decisions");
  }
});

test("Decisions input/cache cost has no output charge", () => {
  assert.equal(
    decisionCost({ input_tokens: 1_000_000, output_tokens: 500, total_tokens: 1_000_500 }),
    0.1
  );
  assert.ok(Math.abs(decisionCost(usage) - 0.00000845) < 1e-12);
  assert.equal(decisionCost({ ...usage, input_tokens: 0 }), 0);
});
