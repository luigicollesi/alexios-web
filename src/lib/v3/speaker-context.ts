/**
 * Speaker labels are diarizer output, not names or persistent identities.
 * Keep confirmed, first-person introductions in the *variable* memory,
 * scoped to the current Python run. Never carry speaker_03 from a previous
 * run over to an unrelated speaker_03.
 */
import {MAX_CONTEXT_CHARS} from "./context-limits.ts";

const BLOCK = /\n?\[Vozes da execucao ([0-9a-f]{8})\]\n((?:speaker_\d{2,8} = [^\n]{1,70}\n?)*)/gi;
const MAP_LINE = /^speaker_(\d{2,8}) = ([^\r\n]{1,50})$/gm;
const SPEAKER = /speaker_\d{2,8}/;
const IDENTIFIED_NAME = /\b(?:me chamo|meu nome (?:é|eh)|pode me chamar de)\s+([\p{L}]{2,32})(?:[\s,.;!?]|$)/iu;

type Mapping = {speaker: string; name: string};

function parseMappings(text: string, runId: string): Mapping[] {
  const prefix = runId.slice(0, 8).toLowerCase();
  const mappings: Mapping[] = [];
  for (const match of text.matchAll(BLOCK)) {
    if (match[1].toLowerCase() !== prefix) continue;
    for (const line of match[2].matchAll(MAP_LINE)) {
      const name = line[2].trim();
      if (/^[\p{L}]{2,32}$/u.test(name)) {
        mappings.push({speaker: "speaker_" + line[1], name});
      }
    }
  }
  return mappings;
}

export function stripSpeakerMappings(text: string): string {
  // Discard any identity block from the old run; it is not a durable identity.
  return text.replace(BLOCK, "\n")
    // Do not entrust an unlabeled line invented by the model as a verified map.
    .replace(/^speaker_\d{2,8}\s*=\s*[^\r\n]+$/gm, "")
    .replace(/\n{3,}/g,"\n\n").trim();
}

export function contextForRun(text: string, runId: string): string {
  const base = stripSpeakerMappings(text);
  const labels = parseMappings(text, runId);
  return joinContext(base, labels, runId);
}

function joinContext(base: string, mappings: Mapping[], runId: string): string {
  const deduped = new Map<string, string>();
  for (const {speaker,name} of mappings) deduped.set(speaker,name);
  const suffix = deduped.size
    ? "\n[Vozes da execucao " + runId.slice(0,8).toLowerCase() + "]\n" +
      [...deduped.entries()].slice(-8)
        .map(([speaker,name]) => speaker + " = " + name).join("\n")
    : "";
  const available = MAX_CONTEXT_CHARS - suffix.length;
  if (available <= 0) return suffix.slice(-MAX_CONTEXT_CHARS);
  return (base.trim().slice(0,available).trim() + suffix).trim();
}

export function explicitNameIntroduction(transcript: string): string | null {
  const match = IDENTIFIED_NAME.exec(transcript);
  if (!match) return null;
  const candidate = match[1];
  // Even with a match, avoid treating generic responses as a person's name.
  if (/^(?:nao|não|assim|ele|ela|voce|você|isso|aqui|mesmo|nome)$/iu.test(candidate)) {
    return null;
  }
  return candidate[0].toLocaleUpperCase("pt-BR") + candidate.slice(1);
}

function introductions(fresh: string, speakerId?: string | null): Mapping[] {
  const mappings: Mapping[] = [];
  const individual = speakerId?.match(SPEAKER)?.[0];
  if (individual) {
    const name = explicitNameIntroduction(fresh);
    if (name) mappings.push({speaker: individual, name});
    return mappings;
  }
  for (const line of fresh.split(/\r?\n/)) {
    const match = /^\[[^\]]*\/(speaker_\d{2,8})\]:\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const name = explicitNameIntroduction(match[2]);
    if (name) mappings.push({speaker: match[1], name});
  }
  return mappings;
}

/** Preserve verified associations through OBSERVE/Fast/RESPOND rewrites. */
export function mergeSpeakerContext(args: {
  previous: string; generated: string; runId: string;
  freshSpeech?: string; speakerId?: string | null;
}): string {
  const mappings = parseMappings(args.previous, args.runId);
  const newlyConfirmed = introductions(args.freshSpeech || "", args.speakerId);
  return joinContext(stripSpeakerMappings(args.generated),
    [...mappings, ...newlyConfirmed], args.runId);
}
