/** Pure JSON contracts for V3 AI; no server-only imports. */
import type {Stance} from "./protocol";
import {MAX_CONTEXT_CHARS} from "./persona-core.ts";

export type ObserveDecision = {
  context: string;
  stance: Stance;
  waitingVariant: 1 | 2;
  /** Recovery without a trustworthy LLM decision; never authorizes speech. */
  degraded?: boolean;
};
export type RespondDecision = ObserveDecision & {
  shouldSpeak: boolean;
  speech: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resposta da IA não é objeto JSON.");
  }
  return value as Record<string, unknown>;
}
function parseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error("A IA não retornou texto.");
  return object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")) as unknown);
}
function parseVisual(v: Record<string, unknown>): ObserveDecision {
  if (typeof v.context !== "string" ||
      !v.context.trim() || v.context.length > 6000 ||
      (v.stance !== "crossed-arm" && v.stance !== "hand-in-pocket") ||
      (v.waitingVariant !== 1 && v.waitingVariant !== 2)) {
    throw new Error("Contexto ou postura inválida na resposta da IA.");
  }
  return {
    context: v.context.trim().slice(0, MAX_CONTEXT_CHARS),
    stance: v.stance,
    waitingVariant: v.waitingVariant,
  };
}
export function parseObserve(raw: unknown): ObserveDecision {
  // Even if a model invents a speech field, OBSERVE will never return it.
  return parseVisual(parseJson(raw));
}
export function parseRespond(raw: unknown): RespondDecision {
  const value = parseJson(raw);
  const visual = parseVisual(value);
  if (typeof value.shouldSpeak !== "boolean" ||
      typeof value.speech !== "string") {
    throw new Error("Decisão de fala inválida.");
  }
  const speech = value.shouldSpeak ? value.speech.trim().slice(0, 600) : "";
  return {...visual, shouldSpeak: Boolean(value.shouldSpeak && speech), speech};
}


/**
 * Deterministic, bounded OBSERVE fallback. Never invents facts or speech.
 * Context stays shared by instance; the label only identifies the speaker.
 * Unlike an exception, this lets the next pending event continue.
 */
export function fallbackObserve(input: {
  context: string; stance: Stance; waitingVariant: number;
  speakerId?: string; transcript?: string;
}): ObserveDecision {
  // Raw utterances are stored as events, never appended verbatim to semantic
  // memory. The next successful OBSERVE will generate a proper summary.
  const context = input.context.trim().slice(-MAX_CONTEXT_CHARS);
  return {
    context: context || "Nenhuma informação confirmada sobre o ambiente.",
    stance: input.stance,
    waitingVariant: input.waitingVariant === 2 ? 2 : 1,
    degraded: true,
  };
}

/** On model failure, never fabricate or publish a response to an open floor. */
export function fallbackRespond(input: {
  context: string; stance: Stance; waitingVariant: number;
}): RespondDecision {
  return {
    context: input.context.trim().slice(-MAX_CONTEXT_CHARS) || "Nenhuma informação confirmada sobre o ambiente.",
    stance: input.stance,
    waitingVariant: input.waitingVariant === 2 ? 2 : 1,
    shouldSpeak: false,
    speech: "",
    degraded: true,
  };
}
