import { handleCallback } from "@vercel/queue";
import { analyzeJobV2, InferenceBusyError } from "@/lib/v2/inference-service";

export const runtime = "nodejs";
export const maxDuration = 120;

// Private queue handler. Each instance can run only one AI inference at a time.
// Contended messages stay durable and retry with controlled backoff rather than
// rapid repeated callbacks competing for the same database lease.
export const POST = handleCallback(
  async (message: unknown) => {
    if (!message || typeof message !== "object" || !("jobId" in message) ||
        typeof message.jobId !== "string") {
      throw new Error("Invalid inference queue message.");
    }
    await analyzeJobV2(message.jobId);
  },
  {
    retry: (error, metadata) => {
      if (error instanceof InferenceBusyError) {
        return { afterSeconds: 100 };
      }
      // OpenRouter timeouts or transient infrastructure failures must remain
      // retryable. Avoid a dense retry loop while the provider is unavailable.
      return { afterSeconds: Math.min(300, 30 * 2 ** Math.min(metadata.deliveryCount, 3)) };
    },
  },
);
