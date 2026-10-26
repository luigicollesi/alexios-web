import type { Capture, Word } from "@/lib/agent-db";
import { AgentError } from "@/lib/agent-db";

export type Transcription = {
  instanceId: string;
  captureId: string;
  windowIndex: number;
  words: Word[];
};

export function parseTranscription(payload: unknown): Transcription {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AgentError(400, "Transcrição inválida.");
  }
  const input = payload as Record<string, unknown>;
  if (typeof input.captureId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(input.captureId)) {
    throw new AgentError(400, "captureId inválido.");
  }
  if (!Number.isSafeInteger(input.windowIndex) || (input.windowIndex as number) < 0) {
    throw new AgentError(400, "windowIndex inválido.");
  }
  if (!Array.isArray(input.words) || input.words.length > 180) {
    throw new AgentError(400, "Lista de palavras inválida.");
  }
  const words: Word[] = [];
  for (const raw of input.words) {
    if (!raw || typeof raw !== "object") throw new AgentError(400, "Palavra inválida.");
    const word = raw as Record<string, unknown>;
    if (typeof word.text !== "string" || typeof word.startMs !== "number" || typeof word.endMs !== "number"
        || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)
        || word.startMs < 0 || word.endMs < word.startMs || word.endMs > 86_400_000) {
      throw new AgentError(400, "Timestamp de transcrição inválido.");
    }
    const text = word.text.replace(/\s+/g, " ").trim().slice(0, 60);
    if (text) words.push({ text, startMs: word.startMs, endMs: word.endMs });
  }
  return { instanceId: String(input.instanceId ?? ""), captureId: input.captureId,
    windowIndex: input.windowIndex as number, words };
}

export function mergeWindow(
  current: Capture | null, captureId: string, index: number, words: Word[],
): { capture: Capture; accepted: Word[] } {
  const capture: Capture = current?.id === captureId
    ? { ...current, tail: [...current.tail] }
    : { id: captureId, index: -1, lastEndMs: -1, tail: [] };
  if (index <= capture.index) return { capture, accepted: [] };

  const accepted: Word[] = [];
  for (const word of words) {
    const norm = word.text.toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}]/gu, "");
    if (word.endMs <= capture.lastEndMs + 90) continue;
    if (word.startMs <= capture.lastEndMs + 100 &&
        capture.tail.some((item) => item.text === norm && Math.abs(item.endMs - word.endMs) < 550)) {
      continue;
    }
    accepted.push(word);
    capture.lastEndMs = Math.max(capture.lastEndMs, word.endMs);
    capture.tail.push({ text: norm, endMs: word.endMs });
    capture.tail = capture.tail.slice(-18);
  }
  capture.index = index;
  return { capture, accepted };
}

export function renderWords(words: Word[]): string {
  return words.map((word) => word.text).join(" ").replace(/\s+([,.;!?])/g, "$1").trim();
}
