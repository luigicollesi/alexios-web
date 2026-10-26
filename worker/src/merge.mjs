// Assemble overlapping 4 s Whisper windows emitted every 3 s.
// Word timestamps are absolute within one recording generation.
export function mergeWindow(session, packet) {
  const next = { ...session };
  const captureId = typeof packet.captureId === "string" ? packet.captureId.slice(0, 80) : "";
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(captureId)) throw new Error("captureId inválido");
  if (!Number.isSafeInteger(packet.windowIndex) || packet.windowIndex < 0) {
    throw new Error("windowIndex inválido");
  }
  const previous = session.capture?.id === captureId ? session.capture : {
    id: captureId, index: -1, lastEndMs: -1, tail: [],
  };
  if (packet.windowIndex <= previous.index) return { session, accepted: 0 };
  if (!Array.isArray(packet.words) || packet.words.length > 180) {
    throw new Error("Lista de palavras inválida");
  }

  const capture = { ...previous, tail: [...previous.tail] };
  const accepted = [];
  for (const item of packet.words) {
    if (!item || typeof item.text !== "string") continue;
    const text = item.text.replace(/\s+/g, " ").trim().slice(0, 60);
    const startMs = item.startMs;
    const endMs = item.endMs;
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) ||
        endMs < startMs || startMs < 0 || endMs > 86_400_000) continue;
    const normalized = text.toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}]/gu, "");
    // Guard against the duplicated 1-second overlap and Whisper timestamp jitter.
    if (endMs <= capture.lastEndMs + 90) continue;
    if (startMs <= capture.lastEndMs + 100 &&
        capture.tail.some((entry) => entry.text === normalized && Math.abs(entry.endMs - endMs) < 550)) {
      continue;
    }
    accepted.push({ text, startMs, endMs });
    capture.lastEndMs = Math.max(capture.lastEndMs, endMs);
    capture.tail.push({ text: normalized, endMs });
    capture.tail = capture.tail.slice(-18);
  }
  capture.index = packet.windowIndex;
  next.capture = capture;
  next.pendingWords = [...(session.pendingWords || []), ...accepted].slice(-420);
  return { session: next, accepted: accepted.length };
}

export function renderWords(words) {
  return words.map((w) => w.text).join(" ").replace(/\s+([,.;!?])/g, "$1").trim();
}

export function validateDecision(value) {
  if (!value || typeof value !== "object") throw new Error("Resposta não é objeto JSON");
  const allowed = ["idle", "listening", "thinking", "speaking"];
  if (typeof value.speech !== "string" || typeof value.context !== "string" ||
      !allowed.includes(value.pose)) throw new Error("Campos JSON inválidos");
  return {
    speech: value.speech.trim().slice(0, 600),
    pose: value.pose,
    context: value.context.trim().slice(0, 3000),
  };
}
