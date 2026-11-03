import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-decisions-route-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "decisions-synthetic-test-secret";
useDecollidedMigrationsDir();
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { POST, OPTIONS } = await import("../../src/app/api/v1/decisions/route.ts");
const body = {
  model: "openai/gpt-6-luna",
  input: "test",
  questions: [{ type: "predicate", instructions: "Is this a test?" }],
};
const request = (key = "", payload: unknown = body) =>
  new Request("http://localhost/v1/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
const newKey = () => keys.createApiKey("decision-test", "decision-test-machine", []);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("missing and invalid keys get 401", async () => {
  for (const key of ["", "not-a-valid-key"]) assert.equal((await POST(request(key))).status, 401);
});
test("invalid body is rejected before selecting an account", async () => {
  const key = await newKey();
  assert.equal(
    (await POST(request(key.key as string, { ...body, model: "codex/gpt-6-luna" }))).status,
    400
  );
});
test("client key limited to chat cannot use Decisions", async () => {
  const key = await newKey();
  await keys.updateApiKeyPermissions(key.id, { allowedEndpoints: ["chat"] });
  assert.equal((await POST(request(key.key as string))).status, 403);
});
test("model restriction denies Decisions", async () => {
  const key = await newKey();
  await keys.updateApiKeyPermissions(key.id, { blockedModels: ["openai/gpt-6-luna"] });
  assert.equal((await POST(request(key.key as string))).status, 403);
});
test("no active OpenAI provider has an explicit non-chat failure", async () => {
  const key = await newKey();
  const response = await POST(request(key.key as string));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /OpenAI connection/);
});
test("forced model cannot be bypassed by calling Decisions", async () => {
  const key = await newKey();
  await keys.updateApiKeyPermissions(key.id, { forcedModel: "DansCombo" });
  assert.equal((await POST(request(key.key as string))).status, 403);
});
test("a key scoped to another connection cannot spend the installed OpenAI key", async () => {
  const providers = await import("../../src/lib/db/providers.ts");
  await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "synthetic-openai",
    apiKey: "synthetic-unused-secret",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  const key = await keys.createApiKey("scoped-decision-test", "decision-test-machine", [], {
    allowedConnections: ["00000000-0000-4000-8000-00000000dead"],
  });
  const response = await POST(request(key.key as string));
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /synthetic-unused-secret/);
});
test("actual streamed byte limit applies without Content-Length", async () => {
  const key = await newKey();
  assert.equal(
    (await POST(request(key.key as string, { ...body, input: "a".repeat(8 * 1024 * 1024) })))
      .status,
    413
  );
});
test("CORS preflight does not spend or need a key", () => {
  assert.equal(OPTIONS().status, 200);
  assert.match(OPTIONS().headers.get("Access-Control-Allow-Headers")!, /Authorization/);
});
