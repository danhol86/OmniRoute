import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-decisions-selection-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "selection-synthetic-secret";
process.env.JWT_SECRET = "selection-synthetic-jwt-secret";
useDecollidedMigrationsDir();
const { buildDecisionTargets, nativeDecisionsUrl } =
  await import("../../src/lib/playground/decisionCatalog.ts");
const { DECISIONS_EXAMPLE, replaceDecisionModel } =
  await import("../../src/lib/playground/decisionsExample.ts");
const core = await import("../../src/lib/db/core.ts");
const { GET } = await import("../../src/app/api/playground/decisions/models/route.ts");
const { POST } = await import("../../src/app/api/playground/decisions/route.ts");
const { mintDashboardSessionToken } =
  await import("../../src/shared/utils/dashboardSessionToken.ts");
const { issueDashboardCsrfToken } = await import("../../src/server/authz/csrf.ts");
const { handleOpenAIDecisions } = await import("../../open-sse/handlers/openaiDecisions.ts");
const providers = await import("../../src/lib/db/providers.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const account = (provider: string, id: string) => ({
  provider,
  id,
  name: id,
  isActive: true,
  authType: "apikey",
  apiKey: "never-disclose",
});
const node = {
  id: "openai-compatible-native-test",
  prefix: "native-test",
  name: "Native test provider",
  type: "openai-compatible",
  baseUrl: "https://native.example/v1",
};
const tagged = {
  id: "vendor/decision-model",
  name: "Custom Decision Model",
  supportedEndpoints: ["decisions"],
  endpointCapabilitySource: "operator",
};

test("catalog offers connected native providers, not chat-only models or OAuth accounts", () => {
  const targets = buildDecisionTargets(
    [
      account("openai", "oa"),
      account(node.id, "custom-account"),
      { ...account("openai", "disabled"), isActive: false },
      { ...account("codex", "codex"), authType: "oauth" },
    ],
    [node],
    { [node.id]: [tagged, { ...tagged, id: "chat-only", supportedEndpoints: ["chat"] }] }
  );
  assert.deepEqual(
    targets.map((t) => t.id),
    ["openai/gpt-6-luna", "native-test/vendor/decision-model"]
  );
  assert.deepEqual(
    targets[0].connections.map((a) => a.id),
    ["oa"]
  );
  assert.equal(targets[1].url, "https://native.example/v1/decisions");
  assert.equal(targets[1].modelId, "vendor/decision-model");
  assert.doesNotMatch(JSON.stringify(targets), /never-disclose/);
});

test("hidden, untrusted, non-native and ambiguous model routes are never guessed", () => {
  const custom = {
    [node.id]: [
      tagged,
      { ...tagged, id: "hidden", isHidden: true },
      { ...tagged, id: "untrusted", endpointCapabilitySource: "defaulted" },
    ],
  };
  assert.equal(buildDecisionTargets([], [node], custom).length, 2);
  assert.equal(buildDecisionTargets([], [node, node], custom).length, 1);
  assert.equal(
    buildDecisionTargets([], [{ ...node, type: "anthropic-compatible" }], custom).length,
    1
  );
  assert.equal(buildDecisionTargets([], [{ ...node, prefix: "openai" }], custom).length, 1);
});

test("saved native base URL is normalized, never a client body URL", () => {
  assert.equal(nativeDecisionsUrl("https://native.example"), "https://native.example/v1/decisions");
  assert.equal(
    nativeDecisionsUrl("https://native.example/api/v1/"),
    "https://native.example/api/v1/decisions"
  );
  assert.equal(
    nativeDecisionsUrl("https://native.example/v1/chat/completions"),
    "https://native.example/v1/decisions"
  );
  for (const url of [
    "http://native.example/v1",
    "file:///etc/passwd",
    "https://user:pass@native.example/v1",
    "https://native.example/v1?key=private",
  ])
    assert.equal(nativeDecisionsUrl(url), null);
});

test("model selection preserves the edited questions, input and native options", () => {
  const custom = {
    ...DECISIONS_EXAMPLE,
    input: "My edited input",
    prompt_cache_key: "project",
    model: "old/model",
  };
  const next = JSON.parse(
    replaceDecisionModel(JSON.stringify(custom), "native-test/vendor/decision-model")
  );
  assert.deepEqual(next, { ...custom, model: "native-test/vendor/decision-model" });
  assert.equal(replaceDecisionModel("{ incomplete", "new/model"), "{ incomplete");
  assert.equal(JSON.parse(replaceDecisionModel("", "new/model")).model, "new/model");
});

test("transport honours a resolved non-OpenAI target and model without rewriting them", async () => {
  let calls = 0;
  const response = await handleOpenAIDecisions(
    {
      body: {
        model: "native-test/vendor/decision-model",
        input: "test",
        questions: [{ type: "predicate", instructions: "Is this a test?" }],
      },
      apiKey: "synthetic-provider-key",
      target: { url: "https://native.example/v1/decisions", model: "vendor/decision-model" },
    },
    async (url, options) => {
      calls++;
      assert.equal(url, "https://native.example/v1/decisions");
      assert.equal(JSON.parse(String(options.body)).model, "vendor/decision-model");
      assert.equal(options.allowRedirect, false);
      assert.equal(options.guard, "public-only");
      return Response.json({
        model: "vendor/decision-model",
        answers: [{ type: "predicate", probability: 0.9 }],
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
      });
    }
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "vendor/decision-model");
  assert.equal(calls, 1);
});

async function signedRequest(pin?: string, model = "openai/gpt-6-luna") {
  const token = await mintDashboardSessionToken(new TextEncoder().encode(process.env.JWT_SECRET));
  const headers = new Headers({
    cookie: `auth_token=${token}`,
    "content-type": "application/json",
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
  });
  const req = new Request("http://localhost/api/playground/decisions", { method: "POST", headers });
  headers.set("x-omniroute-csrf", issueDashboardCsrfToken(req)!.token);
  if (pin) headers.set("X-OmniRoute-Connection", pin);
  return new Request(req.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...DECISIONS_EXAMPLE, model }),
  });
}

test("catalog is session-only and projects no secrets", async () => {
  assert.equal(
    (await GET(new Request("http://localhost/api/playground/decisions/models"))).status,
    401
  );
  await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Test account",
    apiKey: "synthetic-secret-not-returned",
    isActive: true,
  });
  const req = await signedRequest();
  const response = await GET(
    new Request("http://localhost/api/playground/decisions/models", { headers: req.headers })
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /openai\/gpt-6-luna/);
  assert.doesNotMatch(text, /synthetic-secret|apiKey|baseUrl|https:\/\/api/);
});

test("missing or wrong-provider pinned accounts fail instead of using another account", async () => {
  const other = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Non-decision account",
    accessToken: "never-use",
    isActive: true,
  });
  for (const pin of ["missing-account", String(other.id)])
    assert.equal((await POST(await signedRequest(pin))).status, 403);
});

test("unknown model is rejected rather than rewritten to the OpenAI default", async () => {
  assert.equal((await POST(await signedRequest(undefined, "codex/gpt-6-luna"))).status, 400);
});

test("full session route selects the requested compatible account, URL and model", async () => {
  const { createProviderNode } = await import("../../src/lib/db/providers/nodes.ts");
  const { addCustomModel } = await import("../../src/lib/db/models.ts");
  const { handleDecisionsRequest } =
    await import("../../src/app/api/v1/_shared/openaiDecisions.ts");
  await createProviderNode(node);
  await addCustomModel(node.id, tagged.id, tagged.name, "manual", "chat-completions", [
    "decisions",
  ]);
  const one = await providers.createProviderConnection({
    provider: node.id,
    authType: "apikey",
    name: "Selected native account",
    apiKey: "selected-synthetic-key",
    isActive: true,
    testStatus: "active",
  });
  await providers.createProviderConnection({
    provider: node.id,
    authType: "apikey",
    name: "Do not select",
    apiKey: "wrong-synthetic-key",
    isActive: true,
    testStatus: "active",
  });
  let calls = 0;
  const response = await handleDecisionsRequest(
    await signedRequest(String(one.id), `native-test/${tagged.id}`),
    "dashboard-session",
    async (options) => {
      calls++;
      assert.equal(options.apiKey, "selected-synthetic-key");
      assert.equal(options.target?.url, "https://native.example/v1/decisions");
      assert.equal(options.target?.model, tagged.id);
      return Response.json({
        model: tagged.id,
        answers: options.body.questions.map((q) => ({ type: q.type })),
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
      });
    }
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("X-OmniRoute-Connection-Id"), one.id);
  assert.equal(response.headers.get("X-OmniRoute-Provider"), node.id);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "unpriced");
  assert.doesNotMatch(await response.text(), /synthetic-key/);
});

test("pinning cannot escape a client key's allowed-account scope", async () => {
  const keys = await import("../../src/lib/db/apiKeys.ts");
  const { handleDecisionsRequest } =
    await import("../../src/app/api/v1/_shared/openaiDecisions.ts");
  const one = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Allowed account",
    apiKey: "allowed-key",
    isActive: true,
    testStatus: "active",
  });
  const two = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Forbidden account",
    apiKey: "forbidden-key",
    isActive: true,
    testStatus: "active",
  });
  const key = await keys.createApiKey("scoped selection test", "test", [], {
    allowedConnections: [String(one.id)],
  });
  const response = await handleDecisionsRequest(
    new Request("http://localhost/v1/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.key}`,
        "Content-Type": "application/json",
        "X-OmniRoute-Connection": String(two.id),
      },
      body: JSON.stringify({ ...DECISIONS_EXAMPLE, model: "openai/gpt-6-luna" }),
    }),
    "api-key",
    async () => {
      assert.fail("A disallowed account must never be sent upstream");
    }
  );
  assert.equal(response.status, 403);
});
