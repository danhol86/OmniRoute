import { z } from "zod";
import {
  safeOutboundFetch,
  type SafeOutboundFetchOptions,
} from "@/shared/network/safeOutboundFetch";
import { readBoundedResponseText } from "../utils/emptyTurnRetry.ts";
import { errorResponse } from "../utils/error.ts";
import { CORS_HEADERS } from "../utils/cors.ts";

// Native Decisions transport: targets are resolved server-side from explicit capability metadata.
export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DECISIONS_BODY_LIMIT = 8 * 1024 * 1024;
const instructions = z.union([
  z.string().min(1),
  z.array(z.record(z.string(), z.unknown())).min(1),
]);
const question = z
  .object({
    name: z.string().optional(),
    instructions,
    type: z.enum(["predicate", "choice", "score"]),
  })
  .passthrough();

/** Validate admission; OpenAI remains authoritative for its evolving nested wire format. */
export const openaiDecisionsSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    input: z.union([z.string(), z.array(z.record(z.string(), z.unknown())).min(1)]),
    questions: z.array(question).min(1).max(400),
  })
  .passthrough();

export type OpenAIDecisionsBody = z.infer<typeof openaiDecisionsSchema>;
type DecisionFetch = (url: string, options: SafeOutboundFetchOptions) => Promise<Response>;
type ProxyOptions = {
  body: OpenAIDecisionsBody;
  apiKey: string;
  signal?: AbortSignal;
  proxyConfig?: unknown;
  target?: { url: string; model: string };
};

const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const responseSchema = z
  .object({
    model: z.string(),
    answers: z.array(
      z
        .object({
          type: z.enum(["predicate", "choice", "score", "refusal"]),
        })
        .passthrough()
    ),
    usage: usageSchema,
  })
  .passthrough();

export type DecisionUsage = z.infer<typeof usageSchema>;

/** Standard direct OpenAI tariff, USD. Decisions has no output-token charge. */
export function decisionCost(usage: DecisionUsage): number {
  const cached = Math.min(usage.input_tokens, usage.input_tokens_details?.cached_tokens ?? 0);
  const written = Math.min(
    usage.input_tokens - cached,
    usage.input_tokens_details?.cache_write_tokens ?? 0
  );
  return (
    ((usage.input_tokens - cached - written) * 0.1 + cached * 0.01 + written * 0.125) / 1_000_000
  );
}

/** One bounded request; never redirect, replay, translate, or leak an upstream error body. */
export async function handleOpenAIDecisions(
  options: ProxyOptions,
  send: DecisionFetch = safeOutboundFetch
): Promise<Response> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const upstream = await send(options.target?.url ?? OPENAI_DECISIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        ...options.body,
        model: options.target?.model ?? options.body.model.replace(/^openai\//, ""),
      }),
      signal,
      timeoutMs: 30_000,
      guard: "public-only",
      allowRedirect: false,
      retry: false,
      proxyConfig: options.proxyConfig,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const status = upstream.status >= 400 ? upstream.status : 502;
      const response = errorResponse(
        status,
        `Decisions provider returned HTTP ${upstream.status}. Check the selected account, model access and billing.`
      );
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter && retryAfter.length <= 128) response.headers.set("Retry-After", retryAfter);
      return response;
    }
    const text = await readBoundedResponseText(upstream, 2 * 1024 * 1024, 30_000);
    signal.throwIfAborted();
    const data = text ? responseSchema.safeParse(JSON.parse(text)) : null;
    if (!data?.success || data.data.answers.length !== options.body.questions.length) {
      return errorResponse(502, "Invalid OpenAI Decisions response");
    }
    return new Response(text, {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (options.signal?.aborted) return errorResponse(499, "Decision request cancelled");
    if (deadline.aborted || (error instanceof Error && "code" in error && error.code === "TIMEOUT"))
      return errorResponse(504, "OpenAI Decisions timed out");
    return errorResponse(502, "OpenAI Decisions request failed");
  }
}
