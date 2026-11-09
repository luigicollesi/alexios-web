/** Pure gate for TTS requests; avoids charging for stale or unrelated text. */
export type SpeechStatusForTts = {
  agent: { connected: boolean };
  core: {
    power: string;
    protocolVersion: number;
    speech: { seq: number; text: string; at: string | null };
  };
  conversation: {
    activityEpoch: number;
    lastTurn: { receivedAt: string | null } | null;
  } | null;
};

export function currentSpeechForTts(
  status: SpeechStatusForTts, sequence: number, activityEpoch: number,
  now = Date.now(),
): string | null {
  if (!status.agent.connected ||
      status.core.power !== "running" ||
      status.core.protocolVersion !== 3 ||
      !status.conversation ||
      status.conversation.activityEpoch !== activityEpoch ||
      status.core.speech.seq !== sequence) return null;
  const { text, at } = status.core.speech;
  const speechAt = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(speechAt) || speechAt > now + 5_000 ||
      now - speechAt > 12_000 || !text.trim()) return null;
  const turnAt = status.conversation.lastTurn?.receivedAt
    ? Date.parse(status.conversation.lastTurn.receivedAt) : NaN;
  // A new captured turn makes any previous AI speech obsolete.
  if (Number.isFinite(turnAt) && turnAt > speechAt) return null;
  return text.slice(0, 600).trim();
}
