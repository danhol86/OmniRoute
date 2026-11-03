import { handleDecisionsRequest } from "../../v1/_shared/openaiDecisions";

export const runtime = "nodejs";

/** Dashboard-only inference: signed session plus session-bound CSRF, never a client key. */
export async function POST(request: Request): Promise<Response> {
  const response = await handleDecisionsRequest(request, "dashboard-session");
  // Do not expose the public endpoint's CORS policy on a credentialed dashboard route.
  for (const name of [...response.headers.keys()]) {
    if (name.startsWith("access-control-")) response.headers.delete(name);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
