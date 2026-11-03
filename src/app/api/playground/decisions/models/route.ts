import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { getDecisionTargets } from "@/lib/playground/decisionCatalog";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  if (!(await isDashboardSessionAuthenticated(request)))
    return errorResponse(401, "Sign in to load Decisions models.");
  try {
    const targets = await getDecisionTargets();
    return Response.json(
      {
        data: targets
          .filter((t) => t.connections.length > 0)
          .map((t) => ({
            id: t.id,
            name: t.name,
            provider: t.providerId,
            providerLabel: t.providerLabel,
            connections: t.connections,
          })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return errorResponse(503, "Could not load the configured Decisions models.");
  }
}
