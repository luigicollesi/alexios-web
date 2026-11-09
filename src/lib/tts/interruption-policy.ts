/**
 * VAD speech_started/activityEpoch is a preliminary acoustic signal, not a
 * confirmed user interruption. While loudspeaker TTS is active, it can be
 * caused by the assistant's own audio leaking into the microphone.
 *
 * A post-publication, newly transcribed turn is stronger evidence. The simple
 * lexical echo guard is intentionally conservative; real AEC/diarization
 * belongs in the audio capture pipeline, not in browser text matching.
 */
export type TranscribedTurn = {
  sequence: number;
  text: string;
  receivedAt: string | null;
};

export type PlaybackInterruptionContext = {
  speechText: string;
  speechAtMs: number;
  lastTurnSequenceAtStart: number;
};

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True only when a new turn has been transcribed AFTER this answer and is not
 * reasonably a snippet of the AI response heard back through the microphone.
 *
 * Does not claim to reliably distinguish two overlapping human voices.
 */
export function shouldInterruptForConfirmedTurn(
  context: PlaybackInterruptionContext,
  latestTurn: TranscribedTurn | null,
): boolean {
  if (!latestTurn || latestTurn.sequence <= context.lastTurnSequenceAtStart) return false;
  const receivedAtMs = latestTurn.receivedAt ? Date.parse(latestTurn.receivedAt) : NaN;
  if (!Number.isFinite(receivedAtMs) || receivedAtMs <= context.speechAtMs) return false;

  const incoming = normalizedWords(latestTurn.text);
  if (!incoming.length) return false;
  const spoken = normalizedWords(context.speechText);
  if (!spoken.length) return true;

  const snippet = incoming.join(" ");
  const answer = spoken.join(" ");
  if (answer.includes(snippet)) return false;

  // ASR can make punctuation/word errors. Preserve playback when a fragment
  // mostly consists of words from the answer, especially in their order.
  // Require meaningful word agreement; common 1-word overlaps aren't enough.
  const answerTokens = new Set(spoken.filter(word => word.length >= 3));
  const comparable = incoming.filter(word => word.length >= 3);
  const matches = comparable.filter(word => answerTokens.has(word)).length;
  if (comparable.length >= 2 &&
      matches >= 2 &&
      matches / comparable.length >= 0.75) return false;

  return true;
}
