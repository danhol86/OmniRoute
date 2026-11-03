import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-decisions-session-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "session-decisions-test-only";
process.env.JWT_SECRET = "session-decisions-test-only-not-production";
useDecollidedMigrationsDir();
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { mintDashboardSessionToken } =
  await import("../../src/shared/utils/dashboardSessionToken.ts");
const { issueDashboardCsrfToken } = await import("../../src/server/authz/csrf.ts");
const { POST } = await import("../../src/app/api/playground/decisions/route.ts");
const external = await import("../../src/app/api/v1/decisions/route.ts");
const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const body = {
  model: "openai/gpt-6-luna",
  input: "test",
  questions: [{ type: "predicate", instructions: "Is this a test?" }],
};

function request(
  token = "",
  options: { csrf?: boolean; site?: string; auth?: string; payload?: unknown } = {}
) {
  const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost" });
  if (token) headers.set("Cookie", `auth_token=${token}`);
  if (options.site) headers.set("Sec-Fetch-Site", options.site);
  if (options.auth) headers.set("Authorization", `Bearer ${options.auth}`);
  const preliminary = new Request("http://localhost/api/playground/decisions", { headers });
  if (options.csrf !== false) {
    const csrf = issueDashboardCsrfToken(preliminary);
    if (csrf) headers.set("x-omniroute-csrf", csrf.token);
  }
  return new Request(preliminary.url, {
    method: "POST",
    headers,
    body: JSON.stringify(options.payload ?? body),
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Playground requires a signed dashboard session even when login gating is disabled", async () => {
  assert.equal((await POST(request())).status, 401);
  assert.equal((await POST(request("forged-session"))).status, 401);
});
test("an API key alone cannot substitute for the Playground session", async () => {
  const key = await keys.createApiKey("session-test", "session-test-machine", []);
  assert.equal((await POST(request("", { auth: key.key as string }))).status, 401);
});
test("expired and non-dashboard signed tokens are rejected", async () => {
  const expired = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(1)
    .sign(secret);
  const other = await new SignJWT({ scope: "manage" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  for (const token of [expired, other]) assert.equal((await POST(request(token))).status, 401);
});
test("valid session without a CSRF token is rejected", async () => {
  assert.equal(
    (await POST(request(await mintDashboardSessionToken(secret), { csrf: false }))).status,
    403
  );
});
test("CSRF tokens are bound to the signed session", async () => {
  const a = await mintDashboardSessionToken(secret);
  const b = await mintDashboardSessionToken(secret);
  const req = request(a);
  req.headers.set("Cookie", `auth_token=${b}`);
  assert.equal((await POST(req)).status, 403);
});
test("cross-site requests are blocked even with valid session and CSRF", async () => {
  assert.equal(
    (await POST(request(await mintDashboardSessionToken(secret), { site: "cross-site" }))).status,
    403
  );
});
test("logged-in Playground reaches validation without any API key", async () => {
  const response = await POST(request(await mintDashboardSessionToken(secret), { payload: {} }));
  assert.equal(response.status, 400);
});
test("logged-in Playground reaches OpenAI selection without creating or exposing an API key", async () => {
  const before = core.getDbInstance().prepare("SELECT COUNT(*) AS n FROM api_keys").get();
  const response = await POST(request(await mintDashboardSessionToken(secret)));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /No active OpenAI connection/);
  assert.deepEqual(
    core.getDbInstance().prepare("SELECT COUNT(*) AS n FROM api_keys").get(),
    before
  );
});
test("public endpoint still rejects session-only calls, including with CSRF", async () => {
  const req = request(await mintDashboardSessionToken(secret));
  const response = await external.POST(
    new Request("http://localhost/v1/decisions", {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
    })
  );
  assert.equal(response.status, 401);
});
test("Playground form uses session credentials with no API-key entry or browser bearer", () => {
  const source = fs.readFileSync(
    "src/app/(dashboard)/dashboard/endpoint/decisions/DecisionsClient.tsx",
    "utf8"
  );
  assert.match(source, /fetch\("\/api\/playground\/decisions"/);
  assert.match(source, /withDashboardCsrfHeader/);
  assert.match(source, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /type="password"|setKey\(|Authorization:|Bearer \$\{/);
});
test("revoked sessions cannot run Playground requests", async () => {
  const { updateSettings } = await import("../../src/lib/db/settings.ts");
  const { decodeJwt } = await import("jose");
  const token = await mintDashboardSessionToken(secret);
  const payload = decodeJwt(token);
  await updateSettings({ revokedDashboardSessions: [{ jti: payload.jti, exp: payload.exp }] });
  assert.equal((await POST(request(token))).status, 401);
});
