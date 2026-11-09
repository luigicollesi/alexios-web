/** Local selection only. No credentials or transcript are ever logged. */
export const CARTESIA_SAMPLE_RATE = 44_100;
export const CARTESIA_BYTES_PER_SAMPLE = 4;
export const CARTESIA_VOICE_ID = "07b6f895-78b9-4921-8e10-8a21c99c2e8a";

const COOLDOWN_MS = 30 * 60 * 1000;

export function parseCartesiaKeys(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
}

export class CartesiaKeyRing {
  private readonly unavailableUntil = new Map<string, number>();
  constructor(readonly keys: readonly string[], private readonly cooldownMs = COOLDOWN_MS) {}

  candidates(now = Date.now()): string[] {
    return this.keys.filter((key) => (this.unavailableUntil.get(key) ?? 0) <= now);
  }

  markExhausted(key: string, now = Date.now()): void {
    if (this.keys.includes(key)) this.unavailableUntil.set(key, now + this.cooldownMs);
  }
}

export type CartesiaErrorBody = {
  error_code?: unknown;
  title?: unknown;
  message?: unknown;
};

/** Only quota/credit errors trigger key failover; never auth, 429 concurrency or 5xx. */
export function cartesiaOutOfCredit(status: number, raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const body = raw as CartesiaErrorBody;
  if (body.error_code === "quota_exceeded") return true;
  if (status !== 402) return false;
  const title = typeof body.title === "string" ? body.title : "";
  const message = typeof body.message === "string" ? body.message : "";
  return /(?:out of|insufficient|not enough|exhausted|no more)\s+credits?|credit\s+(?:balance|exhausted)/i.test(
    title + " " + message,
  );
}
