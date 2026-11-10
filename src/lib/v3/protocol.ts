/** V3 wire contract shared by API routes and protocol tests. No DB dependencies. */
import {avatarPath, type AvatarForm, type AvatarStance} from './avatar-catalog.ts';
export type V3EventKind = "turn_end" | "turn_chunk" | "floor_open";
export type Stance = AvatarStance;
export type Form = AvatarForm;
export type Frame = "listening" | "speaking" | "waiting_1" | "waiting_2";

export interface Identity {
  instanceId: string;
  runId: string;
}

export type IncomingEvent = Identity & {
  eventId: string;
  sequence: number;
  activityEpoch: number;
  type: V3EventKind;
  turnId?: string;
  speakerId?: string;
  transcript?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  silenceMs?: number;
  afterSequence?: number;
};

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Corpo JSON inválido.");
  }
  return raw as Record<string, unknown>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validUuid = (raw: unknown): raw is string =>
  typeof raw === "string" && uuidPattern.test(raw);
const integer = (raw: unknown, min: number, max = Number.MAX_SAFE_INTEGER): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max;

export function parseIdentity(raw: unknown): Identity {
  const item = record(raw);
  if (typeof item.instanceId !== "string" ||
      !/^[a-zA-Z0-9_-]{20,80}$/.test(item.instanceId) ||
      !validUuid(item.runId)) {
    throw new Error("Identificação da instância ou execução inválida.");
  }
  return { instanceId: item.instanceId, runId: item.runId };
}

export function parseActivity(raw: unknown): Identity & {activityEpoch: number} {
  const item = record(raw);
  const identity = parseIdentity(item);
  if (item.state !== "speech_started" || !integer(item.activityEpoch, 1)) {
    throw new Error("Atividade vocal inválida.");
  }
  return {...identity, activityEpoch: item.activityEpoch};
}

export function parseV3Event(raw: unknown, type: V3EventKind): IncomingEvent {
  const item = record(raw);
  const identity = parseIdentity(item);
  if (!validUuid(item.eventId) || !integer(item.sequence, 1) ||
      !integer(item.activityEpoch, 0)) {
    throw new Error("Identificação ou sequência de evento inválida.");
  }
  const common = {
    ...identity, eventId: item.eventId, sequence: item.sequence,
    activityEpoch: item.activityEpoch, type,
  };
  if (type === "floor_open") {
    if (!integer(item.silenceMs, 250, 300_000) ||
        !integer(item.afterSequence, 0) ||
        item.afterSequence !== item.sequence - 1) {
      throw new Error("Espaço de fala inválido.");
    }
    return {...common, silenceMs: item.silenceMs, afterSequence: item.afterSequence};
  }
  if (!validUuid(item.turnId) ||
      typeof item.speakerId !== "string" ||
      !/^(speaker_[0-9]{2,8}|speaker_unknown)$/.test(item.speakerId) ||
      typeof item.transcript !== "string" ||
      !item.transcript.trim() || item.transcript.length > 6000 ||
      !integer(item.startedAtMs, 0) ||
      !integer(item.endedAtMs, 0) ||
      item.endedAtMs < item.startedAtMs ||
      item.endedAtMs - item.startedAtMs > 300_000) {
    throw new Error("Turno ou transcrição inválida.");
  }
  return {
    ...common, turnId: item.turnId, speakerId: item.speakerId,
    transcript: item.transcript.trim(),
    startedAtMs: item.startedAtMs, endedAtMs: item.endedAtMs,
  };
}

export function characterImage(stance: Stance, frame: Frame, form: Form = "men"): string {
  return avatarPath(form, stance, frame);
}

export function chooseCharacterFrame(
  isSpeaking: boolean, personTalking: boolean, waitingVariant: number,
): Frame {
  if (personTalking) return "listening";
  if (isSpeaking) return "speaking";
  return waitingVariant === 2 ? "waiting_2" : "waiting_1";
}
