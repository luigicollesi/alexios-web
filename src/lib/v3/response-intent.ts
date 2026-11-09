/**
 * Conservative, local guard against classifying an obvious direct interaction
 * as ambient silence. Only the NEWEST fresh utterance is examined; prior memory
 * must never trigger an answer.
 */
export type DirectRequestKind = "connection" | "greeting" | "question";

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
  const connection = /\b(?:conseguindo|consegue|conseguem|ouvindo|escutando|vendo|enxergando)\b.{0,36}\b(?:ver|ouvir|escutar|enxergar|me|voce|aqui)\b/
    .test(speech) ||
    /\b(?:ta|esta|estao|consegue|conseguem)\s+(?:(?:me|nos)\s+)?(?:ouvindo|vendo|escutando|enxergando)\b/.test(speech) ||
    /\b(?:me|nos)\s+(?:ouve|escuta|ve|enxerga)\b/.test(speech);
  if (connection) return "connection";
  if (/^(?:alo|ola|oi|ei)\b/.test(speech) ||
      /\b(?:alexios)\b/.test(speech)) return "greeting";
  if (/\?\s*$/.test(speech) ||
      /^(?:o que|qual|quais|quem|quando|onde|como|quanto|quantos|quantas|por que|porque|sera que|pode me|voce pode|voce sabe)\b/.test(speech)) {
    return "question";
  }
  return null;
}

/**
 * Make a real acknowledgment if a clear direct request was incorrectly
 * classified as silence. Never invent external facts, vision or tool use.
 * Other background speech is still allowed to remain silent.
 */
export function repairDirectSilence<T extends {shouldSpeak: boolean; speech: string}>(
  decision: T, freshTurns: string,
): T & {directSilenceRepaired?: boolean} {
  if (decision.shouldSpeak) return decision;
  const intent = directRequestKind(freshTurns);
  if (!intent) return decision;
  const speech = latestFreshUtterance(freshTurns);
  let acknowledgement: string;
  if (intent === "connection" && /\b(?:ver|vendo|enxergar|enxergando)\b/.test(speech)) {
    acknowledgement = "Estou recebendo sua fala, mas não tenho acesso à câmera ou imagens.";
  } else if (intent === "connection") {
    acknowledgement = "Sim, estou recebendo sua fala. Como posso ajudar?";
  } else if (intent === "greeting") {
    acknowledgement = "Olá, estou ouvindo. Como posso ajudar?";
  } else {
    acknowledgement = "Ouvi sua pergunta, mas não consegui responder agora. Pode reformular?";
  }
  return {...decision, shouldSpeak: true, speech: acknowledgement,
    directSilenceRepaired: true};
}
