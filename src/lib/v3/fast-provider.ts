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
    max_tokens: 180,
    temperature: 0.15,
    stream: false,
    ...(candidate.disableReasoning ? {reasoning: {enabled: false}} : {}),
  };
}

/** Error descriptions are intentionally bounded machine-readable codes. */
export function fastFailureCode(error: unknown): string {
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
