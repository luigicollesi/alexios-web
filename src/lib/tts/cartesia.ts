import "server-only";
import {avatarEmotion, type AvatarForm, type VoiceEmotion} from "@/lib/v3/avatar-catalog";
import {
  CARTESIA_SAMPLE_RATE, voiceForForm,
  CartesiaKeyRing, cartesiaOutOfCredit, parseCartesiaKeys,
} from "./key-manager";

const ENDPOINT = "https://api.cartesia.ai/tts/bytes";
const VERSION = "2026-08-14";
let cachedKeys = "";
let cachedRing: CartesiaKeyRing | null = null;

export class CartesiaTtsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CartesiaTtsError";
  }
}

function keyRing(): CartesiaKeyRing {
  const raw = process.env.CARTESIA_API_KEYS ?? "";
  if (cachedKeys !== raw || !cachedRing) {
    cachedKeys = raw;
    cachedRing = new CartesiaKeyRing(parseCartesiaKeys(raw));
  }
  return cachedRing;
}

/**
 * The upstream starts streaming on a complete transcript.
 * We return the *original* body without materializing it: this is the
 * low-latency, backpressure-friendly path. If headers report a credit error,
 * try the next configured key BEFORE the first byte is forwarded.
 */
export async function cartesiaSpeechStream(
  transcript: string, signal: AbortSignal,
  options: {form?: AvatarForm; emotion?: VoiceEmotion} = {},
): Promise<ReadableStream<Uint8Array>> {
  const ring = keyRing();
  if (ring.keys.length === 0) {
    throw new CartesiaTtsError(503, "TTS indisponível: CARTESIA_API_KEYS não configurada.");
  }
  const candidates = ring.candidates();
  if (!candidates.length) {
    throw new CartesiaTtsError(402, "Todas as chaves Cartesia estão temporariamente sem créditos.");
  }
  const voice = voiceForForm(options.form === "woman" ? "woman" : "men",
    process.env.CARTESIA_VOICE_ID, process.env.CARTESIA_WOMAN_VOICE_ID);
  const emotion = avatarEmotion(options.emotion);
  const useEmotion = process.env.CARTESIA_EMOTION_ENABLED !== "false" && emotion !== "neutral";
  const buildPayload = (withEmotion: boolean) => JSON.stringify({
    model_id: process.env.CARTESIA_MODEL || "sonic-3.6",
    voice,
    locale: process.env.CARTESIA_LOCALE || "pt-BR",
    transcript,
    ...(withEmotion ? {generation_config: {emotion}} : {}),
    output_format: {
      container: "raw",
      encoding: "pcm_f32le",
      sample_rate: CARTESIA_SAMPLE_RATE,
    },
  });
  const payload = buildPayload(useEmotion);


  for (const key of candidates) {
    if (signal.aborted) throw signal.reason;
    let response: Response;
    try {
      const headers = {
        "Authorization": `Bearer ${key}`,
        "Cartesia-Version": process.env.CARTESIA_API_VERSION || VERSION,
        "Content-Type": "application/json",
        "Accept": "audio/*",
      };
      response = await fetch(ENDPOINT, {
        method: "POST", headers, body: payload, cache: "no-store", signal,
      });
      // Emotion tags are beta and officially English-only. If a voice or
      // locale rejects this hint, fall back to natural Sonic prosody.
      if (useEmotion && (response.status === 400 || response.status === 422)) {
        await response.body?.cancel().catch(() => {});
        response = await fetch(ENDPOINT, {
          method: "POST", headers, body: buildPayload(false), cache: "no-store", signal,
        });
      }
    } catch {
      if (signal.aborted) throw signal.reason;
      // Network errors are not evidence that credentials are out of credits.
      throw new CartesiaTtsError(502, "Não foi possível conectar ao Cartesia.");
    }

    if (response.ok && response.body) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json") || contentType.includes("text/")) {
        await response.body.cancel().catch(() => {});
        throw new CartesiaTtsError(502, "A Cartesia retornou um formato de áudio inesperado.");
      }
      return response.body;
    }

    let errorBody: unknown = null;
    try {
      errorBody = JSON.parse((await response.text()).slice(0, 4096));
    } catch {
      // Older API revisions may return non-JSON errors.
    }
    if (cartesiaOutOfCredit(response.status, errorBody)) {
      ring.markExhausted(key);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new CartesiaTtsError(502, "Credencial Cartesia inválida ou sem permissão.");
    }
    if (response.status === 429) {
      throw new CartesiaTtsError(503, "Limite de concorrência da Cartesia atingido.");
    }
    throw new CartesiaTtsError(502, "Falha da Cartesia na geração de voz.");
  }

  throw new CartesiaTtsError(402, "Todas as chaves Cartesia estão sem créditos.");
}
