import {
  extractApiKey,
  isValidApiKey,
  getProviderCredentialsWithQuotaPreflight,
} from "@/sse/services/auth";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  resolveKeyConnectionScope,
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
} from "@/sse/services/keyConnectionScope";
import { isAllRateLimitedCredentials, rateLimitedProviderResponse } from "../_shared/rateLimit";
import { resolveProxyForCredentials } from "@/sse/services/tokenRefresh";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/shared/middleware/bodySizeGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { CORS_HEADERS } from "@omniroute/open-sse/utils/cors.ts";
import {
  handleOpenAIDecisions,
  openaiDecisionsSchema,
  DECISIONS_BODY_LIMIT,
  decisionCost,
  type DecisionUsage,
} from "@omniroute/open-sse/handlers/openaiDecisions.ts";
import { saveCallLog } from "@/lib/usage/callLogs";
import { saveRequestUsage } from "@/lib/usage/usageHistory";
import { recordCost } from "@/domain/costRules";
import { recordKeyQuotaUsage } from "@/domain/keyQuota";
import { recordTokenUsage } from "@omniroute/open-sse/services/tokenLimitCounter.ts";
import { generateRequestId } from "@/shared/utils/requestId";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}

/** Native, API-key-authenticated OpenAI Decisions using the existing OpenAI connection. */
export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  try {
    const key = extractApiKey(request, { allowUrl: false });
    if (!key || !(await isValidApiKey(key)))
      return errorResponse(401, "A valid OmniRoute API key is required");
    let raw: unknown;
    try {
      raw = JSON.parse(
        new TextDecoder().decode(await readRequestBodyWithLimit(request, DECISIONS_BODY_LIMIT))
      );
    } catch (error) {
      return errorResponse(
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "Invalid JSON body or request exceeds 8 MiB"
      );
    }
    const parsed = openaiDecisionsSchema.safeParse(raw);
    if (!parsed.success)
      return errorResponse(
        400,
        "Use gpt-6-luna or openai/gpt-6-luna, input, and 1-400 predicate, choice or score questions with instructions"
      );
    const model = "openai/gpt-6-luna";
    const policy = await enforceApiKeyPolicy(request, model);
    if (policy.rejection) return policy.rejection;
    if (
      policy.apiKeyInfo?.forcedModel &&
      ![model, "gpt-6-luna"].includes(policy.apiKeyInfo.forcedModel)
    ) {
      return errorResponse(403, "This API key is pinned to a different model");
    }
    const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
    if (scope.rejection) return scope.rejection;
    const credentials = await getProviderCredentialsWithQuotaPreflight(
      "openai",
      null,
      scope.allowedConnections,
      "gpt-6-luna"
    );
    if (!credentials)
      return errorResponse(
        503,
        "No active OpenAI connection. Add an OpenAI API key under Providers."
      );
    if (isKeyScopeBlockedCredentials(credentials))
      return keyScopeBlockedResponse("openai", credentials);
    if (isAllRateLimitedCredentials(credentials))
      return rateLimitedProviderResponse("openai", credentials);
    if (
      !("apiKey" in credentials) ||
      typeof credentials.apiKey !== "string" ||
      !credentials.apiKey ||
      !("connectionId" in credentials) ||
      typeof credentials.connectionId !== "string"
    )
      return errorResponse(503, "Decisions requires an OpenAI API-key connection, not Codex OAuth");
    const proxyConfig = await resolveProxyForCredentials("openai", credentials);
    const response = await handleOpenAIDecisions({
      body: parsed.data,
      apiKey: credentials.apiKey,
      signal: request.signal,
      proxyConfig,
    });
    const requestId = generateRequestId();
    response.headers.set("X-OmniRoute-Request-Id", requestId);
    response.headers.set("X-OmniRoute-Provider", "openai");
    response.headers.set("Cache-Control", "no-store");
    const usage: DecisionUsage | undefined = response.ok
      ? (await response.clone().json()).usage
      : undefined;
    const cost = usage ? decisionCost(usage) : undefined;
    const apiKeyId = policy.apiKeyInfo?.id;
    try {
      if (usage) {
        await saveRequestUsage({
          provider: "openai",
          model: "gpt-6-luna",
          tokens: usage,
          success: true,
          connectionId: credentials.connectionId,
          apiKeyId,
          endpoint: "/v1/decisions",
          latencyMs: Date.now() - started,
        });
        if (apiKeyId) {
          recordCost(apiKeyId, cost!, {
            provider: "openai",
            model: "gpt-6-luna",
            tokens: usage,
            requestId,
            success: true,
          });
          recordTokenUsage(apiKeyId, "openai", "gpt-6-luna", usage.total_tokens);
        }
        response.headers.set("X-OmniRoute-Cost", String(cost));
        response.headers.set("X-OmniRoute-Cost-Status", "estimated");
      }
      recordKeyQuotaUsage(apiKeyId, usage?.total_tokens ?? 0);
      await saveCallLog({
        method: "POST",
        path: "/v1/decisions",
        status: response.status,
        model: "gpt-6-luna",
        provider: "openai",
        duration: Date.now() - started,
        connectionId: credentials.connectionId,
        apiKeyId,
        tokens: usage,
        requestId,
        cost,
      });
    } catch {
      // A successful, billable call must not become a retryable failure because logging failed.
      console.warn("[Decisions] Could not persist request accounting");
    }
    return response;
  } catch {
    return errorResponse(
      503,
      "Decisions is temporarily unavailable. Check the OpenAI connection and server logs."
    );
  }
}
