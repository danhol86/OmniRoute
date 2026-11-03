import { handleDecisionsRequest } from "../_shared/openaiDecisions";
import { CORS_HEADERS } from "@omniroute/open-sse/utils/cors.ts";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-OmniRoute-Connection",
    },
  });
}

/** Public inference always requires an OmniRoute client key, even with a dashboard cookie. */
export function POST(request: Request): Promise<Response> {
  return handleDecisionsRequest(request, "api-key");
}
