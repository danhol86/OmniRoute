import {
  extractApiKey,
  isValidApiKey,
  getProviderCredentialsWithQuotaPreflight,
} from "@/sse/services/auth";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  resolveKeyConnectionScope,
  narrowConnectionScope,
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
} from "@/sse/services/keyConnectionScope";
import { isAllRateLimitedCredentials, rateLimitedProviderResponse } from "./rateLimit";
import { resolveProxyForCredentials } from "@/sse/services/tokenRefresh";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/shared/middleware/bodySizeGuard";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { validateDashboardCsrfToken } from "@/server/authz/csrf";
import { validateBrowserMutationOrigin } from "@/server/origin/publicOrigin";
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
import { getDecisionTargets, canonicalDecisionModel } from "@/lib/playground/decisionCatalog";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";
import { generateRequestId } from "@/shared/utils/requestId";

/** Called only by the fixed API-key and dashboard route entry points; never request-selected. */
export async function handleDecisionsRequest(
  request: Request,
  mode: "api-key" | "dashboard-session",
  dispatch = handleOpenAIDecisions
): Promise<Response> {
  const started = Date.now();
  try {
    if (mode === "dashboard-session") {
      if (!(await isDashboardSessionAuthenticated(request))) {
        return errorResponse(401, "Your session has expired. Sign in again to use Decisions.");
      }
      // Session-bound CSRF is mandatory here, including behind a reverse proxy whose
      // internal request origin differs from the browser's public origin.
      const origin = validateBrowserMutationOrigin(request);
      if (origin.reason === "cross-site-fetch-metadata" || !validateDashboardCsrfToken(request)) {
        return errorResponse(
          403,
          "Refresh the Playground and try again (session verification failed)."
        );
      }
    } else {
      const key = extractApiKey(request, { allowUrl: false });
      if (!key || !(await isValidApiKey(key))) {
        return errorResponse(401, "A valid OmniRoute API key is required");
      }
    }
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
        "Select a configured Decisions model and provide input and 1-400 predicate, choice or score questions with instructions"
      );
    const model = canonicalDecisionModel(parsed.data.model);
    const target = (await getDecisionTargets()).find((entry) => entry.id === model);
    if (!target)
      return errorResponse(
        400,
        "This model has no configured native Decisions route. Select a supported model; no fallback to OpenAI or chat is performed."
      );
    const provider = target.providerId;
    const modelId = target.modelId;
    const policy =
      mode === "dashboard-session"
        ? { apiKey: null, apiKeyInfo: null, rejection: null }
        : await enforceApiKeyPolicy(request, model);
    const endpoint = mode === "dashboard-session" ? "/api/playground/decisions" : "/v1/decisions";
    if (policy.rejection) return policy.rejection;
    if (
      policy.apiKeyInfo?.forcedModel &&
      canonicalDecisionModel(policy.apiKeyInfo.forcedModel) !== model
    ) {
      return errorResponse(403, "This API key is pinned to a different model");
    }
    const scope = await resolveKeyConnectionScope(policy.apiKeyInfo);
    if (scope.rejection) return scope.rejection;
    const pin = request.headers.get("x-omniroute-connection")?.trim();
    if (pin && !target.connections.some((connection) => connection.id === pin))
      return errorResponse(403, "The selected account is not active for this Decisions provider.");
    if (!target.connections.length)
      return errorResponse(
        503,
        "No active OpenAI connection or compatible Decisions account is available for this model."
      );
    const allowed = narrowConnectionScope(
      scope.allowedConnections,
      pin ? [pin] : target.connections.map((connection) => connection.id)
    );
    const credentials = await getProviderCredentialsWithQuotaPreflight(
      provider,
      null,
      allowed,
      modelId
    );
    if (!credentials)
      return errorResponse(
        503,
        "No active OpenAI connection. Add an OpenAI API key under Providers."
      );
    if (isKeyScopeBlockedCredentials(credentials))
      return keyScopeBlockedResponse(provider, credentials);
    if (isAllRateLimitedCredentials(credentials))
      return rateLimitedProviderResponse(provider, credentials);
    if (
      !("apiKey" in credentials) ||
      typeof credentials.apiKey !== "string" ||
      !credentials.apiKey ||
      !("connectionId" in credentials) ||
      typeof credentials.connectionId !== "string"
    )
      return errorResponse(503, "Decisions requires an OpenAI API-key connection, not Codex OAuth");
    const proxyConfig = await resolveProxyForCredentials(provider, credentials);
    if (provider !== "openai" && mode === "api-key") {
      const pricing = await calculateCostDetailed(provider, modelId, {
        input_tokens: 1,
        output_tokens: 0,
      });
      if (!pricing.priced)
        return errorResponse(
          400,
          "Configure pricing for this Decisions model before using client API keys."
        );
    }
    const response = await dispatch({
      body: parsed.data,
      target: { url: target.url, model: modelId },
      apiKey: credentials.apiKey,
      signal: request.signal,
      proxyConfig,
    });
    const requestId = generateRequestId();
    response.headers.set("X-OmniRoute-Request-Id", requestId);
    response.headers.set("X-OmniRoute-Provider", provider);
    response.headers.set("X-OmniRoute-Connection-Id", credentials.connectionId);
    response.headers.set("X-OmniRoute-Model", model);
    response.headers.set("Cache-Control", "no-store");
    const usage: DecisionUsage | undefined = response.ok
      ? (await response.clone().json()).usage
      : undefined;
    const price =
      usage && provider !== "openai" ? await calculateCostDetailed(provider, modelId, usage) : null;
    const cost = usage
      ? provider === "openai"
        ? decisionCost(usage)
        : price?.priced
          ? price.costUsd
          : undefined
      : undefined;
    const apiKeyId = policy.apiKeyInfo?.id;
    try {
      if (usage) {
        await saveRequestUsage({
          provider,
          model: modelId,
          tokens: usage,
          success: true,
          connectionId: credentials.connectionId,
          apiKeyId,
          endpoint,
          latencyMs: Date.now() - started,
        });
        if (apiKeyId && cost !== undefined) {
          recordCost(apiKeyId, cost!, {
            provider,
            model: modelId,
            tokens: usage,
            requestId,
            success: true,
          });
          recordTokenUsage(apiKeyId, provider, modelId, usage.total_tokens);
        }
        if (cost !== undefined) response.headers.set("X-OmniRoute-Cost", String(cost));
        response.headers.set(
          "X-OmniRoute-Cost-Status",
          cost === undefined ? "unpriced" : "estimated"
        );
      }
      recordKeyQuotaUsage(apiKeyId, usage?.total_tokens ?? 0);
      await saveCallLog({
        method: "POST",
        path: endpoint,
        status: response.status,
        model: modelId,
        provider,
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
      "Decisions is temporarily unavailable. Check the selected provider account and server logs."
    );
  }
}
