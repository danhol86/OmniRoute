import { isReservedProviderPrefix } from "@/shared/constants/reservedProviderPrefixes";
import { getProviderConnections } from "@/lib/db/providers";
import { getProviderNodes } from "@/lib/db/providers/nodes";
import { getAllCustomModels } from "@/lib/db/models";
import { isTrustedEndpointCapabilitySource } from "@/shared/constants/modelSupportedEndpoints";

type Row = Record<string, unknown>;
export interface DecisionTarget {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  name: string;
  url: string;
  connections: Array<{ id: string; name: string }>;
}

/** Configured native Decisions endpoints only. Request bodies can never select a URL. */
export function nativeDecisionsUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string") return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    const base = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/(?:chat\/completions|responses|decisions)$/, "");
    url.pathname = `${base || "/v1"}/decisions`;
    return url.href;
  } catch {
    return null;
  }
}

/** Pure projection: never return a credential, raw node record, or guessed chat capability. */
export function buildDecisionTargets(
  connections: Row[],
  nodes: Row[],
  customModels: Record<string, unknown>
): DecisionTarget[] {
  const accounts = (provider: string) =>
    connections
      .filter(
        (c) =>
          c.provider === provider &&
          c.isActive !== false &&
          c.isActive !== 0 &&
          typeof c.id === "string" &&
          typeof c.authType === "string" &&
          c.authType.toLowerCase().replace(/[-_]/g, "") === "apikey"
      )
      .map((c) => ({
        id: String(c.id),
        name: typeof c.name === "string" ? c.name : "Saved account",
      }));
  const targets: DecisionTarget[] = [
    {
      id: "openai/gpt-6-luna",
      providerId: "openai",
      providerLabel: "OpenAI",
      modelId: "gpt-6-luna",
      name: "GPT-6 Luna",
      url: "https://api.openai.com/v1/decisions",
      connections: accounts("openai"),
    },
  ];
  for (const node of nodes) {
    if (
      node.type !== "openai-compatible" ||
      typeof node.id !== "string" ||
      typeof node.prefix !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(node.prefix) ||
      isReservedProviderPrefix(node.prefix)
    )
      continue;
    const url = nativeDecisionsUrl(node.baseUrl);
    if (!url) continue;
    const models = customModels[node.id];
    if (!Array.isArray(models)) continue;
    for (const row of models) {
      if (!row || typeof row !== "object") continue;
      const model = row as Row;
      if (
        typeof model.id !== "string" ||
        !model.id.trim() ||
        model.isHidden === true ||
        !Array.isArray(model.supportedEndpoints) ||
        !model.supportedEndpoints.includes("decisions") ||
        !isTrustedEndpointCapabilitySource(model.endpointCapabilitySource)
      )
        continue;
      targets.push({
        id: `${node.prefix}/${model.id}`,
        providerId: node.id,
        providerLabel: typeof node.name === "string" ? node.name : node.prefix,
        modelId: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
        url,
        connections: accounts(node.id),
      });
    }
  }
  // Ambiguous prefixes must never route to whichever node happened to be first.
  return targets.filter((target) => targets.filter((t) => t.id === target.id).length === 1);
}

export async function getDecisionTargets(): Promise<DecisionTarget[]> {
  const [connections, nodes, models] = await Promise.all([
    getProviderConnections(),
    getProviderNodes(),
    getAllCustomModels(),
  ]);
  return buildDecisionTargets(connections as Row[], nodes as Row[], models);
}

export function canonicalDecisionModel(model: string): string {
  return model === "gpt-6-luna" ? "openai/gpt-6-luna" : model;
}
