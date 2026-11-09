/**
 * Contextual turn-taking is mainly decided by the model. This conservative
 * safeguard only handles clear addresses or ambiguous connection checks with
 * one recently observed voice and a genuine turn-taking pause.
 *
 * A recognized speaker ID is not proof of a person's identity or of how many
 * people are physically present. Never use historical memory as a new request.
 */
export type DirectRequestKind = "connection" | "greeting" | "question";
export type ResponseCues = {
  /** Duration reported by the voice agent when it opened this response floor. */
  silenceMs?: number;
  /** Distinct non-unknown speaker IDs seen in the current run recently. */
  observedSpeakers?: number | null;
};

function latestFreshUtterance(freshTurns: string): string {
  const lines = freshTurns.split(/\r?\n/)
    .map(line => line.replace(/^\[[^\]]{1,100}\]:\s*/, "").trim())
    .filter(Boolean);
  return (lines.at(-1) || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function directRequestKind(freshTurns: string): DirectRequestKind | null {
  const speech = latestFreshUtterance(freshTurns);
  if (!speech || speech === "(nenhuma fala nova)") return null;
  const connection =
    /\b(?:conseguindo|consegue|conseguem|ouvindo|escutando|vendo|enxergando)\b.{0,36}\b(?:ver|ve|ouvir|escutar|enxergar|me|voce|aqui)\b/.test(speech) ||
    /\b(?:ta|esta|estao|consegue|conseguem)\s+(?:(?:me|nos)\s+)?(?:ouvindo|vendo|escutando|enxergando)\b/.test(speech) ||
    /\b(?:me|nos)\s+(?:ouve|escuta|ve|enxerga)\b/.test(speech);
  if (connection) return "connection";
  if (/^(?:alo|ola|oi|ei)\b/.test(speech)) return "greeting";
  if (/\?\s*$/.test(speech) ||
      /^(?:o que|qual|quais|quem|quando|onde|como|quanto|quantos|quantas|por que|porque|sera que|pode me|voce pode|voce sabe)\b/.test(speech)) {
    return "question";
  }
  return null;
}

/**
 * Do not override a model's choice to remain silent just because a sentence
 * has a question mark. Other people may be conversing. With explicit address
 * we can acknowledge; with only one *observed* voice, a connection check and
 * a pause, we may ask who was addressed without claiming anyone is alone.
 */
export function repairDirectSilence<T extends {shouldSpeak: boolean; speech: string}>(
  decision: T, freshTurns: string, cues: ResponseCues = {},
): T & {directSilenceRepaired?: boolean} {
  if (decision.shouldSpeak) return decision;
  const speech = latestFreshUtterance(freshTurns);
  const intent = directRequestKind(freshTurns);
  if (!intent) return decision;

  const explicitAddress = /\b(?:alexios|alexio|alessios|alecsios|assistente)\b/.test(speech);
  const uncertainConnection =
    (intent === "connection" || (intent === "greeting" && /^alo\b/.test(speech))) &&
    cues.observedSpeakers === 1 &&
    Number.isFinite(cues.silenceMs) && Number(cues.silenceMs) >= 1100;

  if (!explicitAddress && !uncertainConnection) return decision;
  const visual = /\b(?:ver|ve|vendo|enxergar|enxergando)\b/.test(speech);
  let response: string;
  if (explicitAddress && visual) {
    response = "Recebo sua fala, mas não tenho acesso à câmera ou a imagens.";
  } else if (explicitAddress) {
    response = "Estou ouvindo. Como posso ajudar?";
  } else if (visual) {
    response = "Está falando comigo? Recebo sua fala, mas não vejo imagens.";
  } else {
    response = "Está falando comigo? Estou recebendo sua fala.";
  }
  return {...decision, shouldSpeak: true, speech: response,
    directSilenceRepaired: true};
}
