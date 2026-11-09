/**
 * Pure OpenRouter compatibility helpers for the low-latency V3 response.
 * Never log a request body, completion text, credential, or provider raw
 * error message: they may include private conversation content.
 */

export type FastModelCandidate = {
  model: string;
  timeoutMs: number;
  disableReasoning: boolean;
};

const DEFAULT_FREE_MODEL = "nvidia/nemotron-3.5-lightning:free";

/**
 * One model setting is the default for OBSERVE and Fast Response:
 * OPENROUTER_MODEL. A fast-specific override or a distinct fallback can
 * still be configured, but neither is required for normal operation.
 */
export function fastModelCandidates(env: {
  shared?: string;
  primary?: string;
  fallback?: string;
  timeoutMs?: string;
}): FastModelCandidate[] {
  const primary = env.primary?.trim() || env.shared?.trim() || DEFAULT_FREE_MODEL;
  // No implicit switch to another model (e.g. openrouter/free). This keeps
  // model selection deterministic and avoids unnecessary duplicated env vars.
  const fallback = env.fallback?.trim() || primary;
  const mainTimeout = Math.min(4_000, Math.max(1_200,
    Number(env.timeoutMs) || 2_400));
  const candidates: FastModelCandidate[] = [
    {model: primary, timeoutMs: mainTimeout, disableReasoning: true},
  ];
  if (fallback !== primary) {
    candidates.push({model: fallback, timeoutMs: 3_000, disableReasoning: false});
  }
  return candidates;
}

/**
 * Minimal OpenAI-compatible request: optional response_format/provider
 * filters can exclude every free endpoint, turning a valid model into a
 * 400/404 without even starting inference.
 */
export function fastCompletionBody(candidate: FastModelCandidate, messages: Array<{
  role: string; content: string;
}>): Record<string, unknown> {
  return {
    model: candidate.model,
    messages,
    max_tokens: 560,
    temperature: 0.15,
    stream: false,
    ...(candidate.disableReasoning ? {reasoning: {enabled: false}} : {}),
  };
}

/** A provider can reply 200 with no final content, or text parts. Do not
 * ever log completion contents or reasoning; only structural metadata.
 */
export class OpenRouterShapeError extends Error {
  readonly kind: "no_choice" | "empty_content" | "truncated";
  readonly finishReason: string;
  readonly contentShape: string;
  readonly hasReasoning: boolean;
  constructor(kind: OpenRouterShapeError["kind"], details: {
    finishReason?: unknown; content?: unknown; reasoning?: unknown;
  } = {}) {
    super("OpenRouter response shape: " + kind);
    this.name = "OpenRouterShapeError";
    this.kind = kind;
    this.finishReason = typeof details.finishReason === "string"
      ? details.finishReason.slice(0, 24) : "missing";
    this.contentShape = Array.isArray(details.content)
      ? "array" : details.content === null ? "null" : typeof details.content;
    this.hasReasoning = typeof details.reasoning === "string" &&
      details.reasoning.length > 0;
  }
}

/** Extract only final assistant text. Never treat reasoning as an answer. */
export function openRouterCompletionText(raw: unknown): string {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choice = choices[0];
  if (!choice || typeof choice !== "object") {
    throw new OpenRouterShapeError("no_choice");
  }
  const item = choice as Record<string, unknown>;
  const message = item.message && typeof item.message === "object"
    ? item.message as Record<string, unknown> : {};
  const details = {finishReason: item.finish_reason,
    content: message.content, reasoning: message.reasoning};
  if (item.finish_reason === "length") {
    throw new OpenRouterShapeError("truncated", details);
  }
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const combined = content.map(part => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string"
        ? item.text : "";
    }).filter(Boolean).join("");
    if (combined.trim()) return combined;
  }
  throw new OpenRouterShapeError("empty_content", details);
}

export function fastShouldUseQueuedFallback(reason: string): boolean {
  // Silencing a provider failure loses the whole response window. Route it
  // through the already-durable V3 queue instead, never replaying older floors.
  return reason !== "missing_api_key" && reason !== "http_401" &&
    reason !== "http_403";
}

/** Error descriptions are intentionally bounded machine-readable codes. */
export function fastFailureCode(error: unknown): string {
  if (error instanceof OpenRouterShapeError) return error.kind;
  if (error instanceof FastProviderHttpError) {
    return "http_" + error.status;
  }
  if (error instanceof Error && /OPENROUTER_API_KEY ausente/.test(error.message)) {
    return "missing_api_key";
  }
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "model_timeout";
  }
  if (error instanceof Error && /missing|fields|JSON|truncad|parse/i.test(error.message)) {
    return "invalid_response";
  }
  return "provider_error";
}

export class FastProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("OpenRouter fast HTTP " + status);
    this.status = status;
    this.name = "FastProviderHttpError";
  }
}

export function fastShouldTryFallback(reason: string): boolean {
  // Don't repeat invalid credentials or account access problems.
  return reason !== "http_401" && reason !== "http_403";
}
