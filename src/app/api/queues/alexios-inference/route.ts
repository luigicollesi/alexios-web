import { handleCallback } from "@vercel/queue";
import { analyzeJobV2 } from "@/lib/v2/inference-service";

export const runtime = "nodejs";
export const maxDuration = 120;

// Private Vercel Queues push consumer: not reachable as a public HTTP endpoint.
export const POST = handleCallback(async (message: unknown) => {
  if (!message || typeof message !== "object" || !("jobId" in message) ||
      typeof message.jobId !== "string") {
    throw new Error("Invalid inference queue message.");
  }
  await analyzeJobV2(message.jobId);
});
