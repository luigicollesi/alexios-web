import "server-only";
import {
  parseObserve, parseRespond, fallbackObserve, fallbackRespond,
  type ObserveDecision, type RespondDecision,
} from "@/lib/v3/model-protocol";
import {v3Messages} from "@/lib/v3/persona-core";
import {repairDirectSilence, type ResponseCues} from "@/lib/v3/response-intent";
import {openRouterCompletionText, OpenRouterShapeError} from "@/lib/v3/fast-provider";
import type {Frame} from "@/lib/v3/protocol";

type Task = "OBSERVE" | "RESPOND";
type Input = {
  context: string;
  stance: "crossed-arm" | "hand-in-pocket";
  waitingVariant: number;
  frame: Frame;
  mode: Task;
  speakerId?: string;
  transcript?: string;
  recentTurns?: string;
  responseCues?: ResponseCues;
};

// One shared persona contract across queued observation, legacy response
// and the V3 fast lane. Only freshSpeech is ever treated as a new request.
function messages(input: Input) {
  return v3Messages({
    context: input.context,
    stance: input.stance,
    waitingVariant: input.waitingVariant,
    frame: input.frame,
    freshSpeech: input.mode === "OBSERVE"
      ? "[" + (input.speakerId || "speaker_unknown") + "] " + (input.transcript || "")
      : input.recentTurns || "",
    responseWindow: input.mode === "RESPOND",
    responseCues: input.responseCues,
  });
}

async function requestModel(input: Input): Promise<ObserveDecision | RespondDecision> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY não configurada.");
  const primary = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free";
  const backup = process.env.OPENROUTER_FALLBACK_MODEL?.trim();
  const models = backup && backup !== primary ? [primary, backup] : [primary];
  const jsonMode = process.env.ALEXIOS_V3_JSON_MODE === "true";
  let lastError = "no_response";

  for (const [idx, model] of models.entries()) {
    // A retry is allowed only for malformed/incomplete JSON. Provider/network
    // failure proceeds to next configured model or deterministic fallback.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeout = models.length === 1 ? 28_000 : idx === 0 ? 20_000 : 22_000;
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://alexios-web.vercel.app",
            "X-Title": "Alexios V3",
          },
          body: JSON.stringify({
            model, messages: messages(input),
            reasoning: {enabled: false},
            temperature: 0.15,
            max_tokens: input.mode === "OBSERVE" ? 850 : 900,
            stream: false,
            // Optional: support depends on the exact OpenRouter model/provider.
            ...(jsonMode ? {response_format: {type: "json_object"}} : {}),
          }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
          lastError = "http_" + response.status;
          if ([400, 401, 403].includes(response.status)) {
            // Invalid model configuration or credentials must remain visible
            // as an operational error, rather than being silently ignored.
            throw new Error("OpenRouter HTTP " + response.status + " (" + model + ")");
          }
          break;
        }
        const data: unknown = await response.json();
        const raw = openRouterCompletionText(data);
        return input.mode === "OBSERVE" ? parseObserve(raw) :
          repairDirectSilence(parseRespond(raw), input.recentTurns || "", input.responseCues);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (/OpenRouter HTTP (400|401|403)/.test(err.message)) throw err;
        const malformed = err instanceof SyntaxError ||
          err instanceof OpenRouterShapeError ||
          /JSON|json|contexto ou postura inválida|Decisão de fala inválida|não retornou texto/i
            .test(err.message);
        lastError = err instanceof OpenRouterShapeError ? err.kind :
          malformed ? "invalid_json" :
          err.name === "TimeoutError" || err.name === "AbortError"
            ? "timeout" : "provider_error";
        console.warn("[Alexios V3] resposta do modelo não utilizada", {
          mode: input.mode, reason: lastError, attempt, modelFallbackIndex: idx,
          ...(err instanceof OpenRouterShapeError
            ? {finishReason: err.finishReason, contentShape: err.contentShape,
               hasReasoning: err.hasReasoning} : {}),
        });
        if (!malformed || attempt === 2) break;
      }
    }
  }

  // Never let an unreliable model response block subsequent events.
  // On provider failure keep the previous compact memory unchanged; raw
  // transcriptions remain in the event log and must not pollute memory.
  // For an open floor, only explicit address/clarification cues may authorize
  // a safe acknowledgement; ambient discussion stays silent.
  console.warn("[Alexios V3] fallback determinístico", {
    mode: input.mode, reason: lastError,
  });
  return input.mode === "OBSERVE" ? fallbackObserve(input) :
    repairDirectSilence(fallbackRespond(input), input.recentTurns || "", input.responseCues);
}

export async function observeV3(input: Omit<Input,"mode">): Promise<ObserveDecision> {
  return await requestModel({...input, mode: "OBSERVE"}) as ObserveDecision;
}
export async function respondV3(input: Omit<Input,"mode">): Promise<RespondDecision> {
  return await requestModel({...input, mode: "RESPOND"}) as RespondDecision;
}
