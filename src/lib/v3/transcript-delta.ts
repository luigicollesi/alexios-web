/**
 * V3 microphone input may repeat the earlier finalized utterance as a prefix
 * of a later transcription. Remove only a complete, recent prefix when the
 * incoming transcription contains additional words; keep original payload
 * intact for event-id idempotency and diagnostics.
 *
 * Speaker IDs are not compared: the diarizer may renumber the same voice.
 */
const WORDS = /[\p{L}\p{N}]+/gu;

function tokens(text: string) {
  return [...text.matchAll(WORDS)].map(match => ({
    value: match[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR"),
    index: match.index,
  }));
}

export function latestUtteranceFromCumulative(
  incoming: string, previous: string | null | undefined,
): string {
  const current = incoming.replace(/\s+/g, " ").trim();
  const earlier = (previous || "").replace(/\s+/g, " ").trim();
  if (!current || !earlier) return current;
  const prefix = tokens(earlier);
  const words = tokens(current);
  if (prefix.length === 0 || words.length <= prefix.length) return current;

  // A one-/two-word fragment is not a complete previous utterance unless
  // it ended with a sentence boundary (e.g. "Alô?" or "Oi!").
  if (prefix.length < 3 && !/[.!?…]$/.test(earlier)) return current;
  if (!prefix.every((token, i) => token.value === words[i]?.value)) {
    return current;
  }
  const remainder = current.slice(words[prefix.length].index).trim();
  return remainder || current;
}
