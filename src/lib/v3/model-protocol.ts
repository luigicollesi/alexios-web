/** Pure JSON contracts for V3 AI; no server-only imports. */
import type {Stance} from "./protocol";

export type ObserveDecision = {
  context: string;
  stance: Stance;
  waitingVariant: 1 | 2;
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
      v.context.length > 6000 ||
      (v.stance !== "crossed-arm" && v.stance !== "hand-in-pocket") ||
      (v.waitingVariant !== 1 && v.waitingVariant !== 2)) {
    throw new Error("Contexto ou postura inválida na resposta da IA.");
  }
  return {
    context: v.context.trim().slice(0, 3000),
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
