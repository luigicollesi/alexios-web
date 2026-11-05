import {handleCallback} from "@vercel/queue";
import {processEventV3, V3DeferredError} from "@/lib/v3/event-processor";

export const runtime = "nodejs";
export const maxDuration = 120;

// Private Vercel Queue consumer; no public HTTP access to this route.
export const POST = handleCallback(async (message: unknown) => {
  if (!message || typeof message !== "object" ||
      !("eventId" in message) || typeof message.eventId !== "string") {
    throw new Error("Mensagem V3 inválida.");
  }
  await processEventV3(message.eventId);
}, {
  retry: (error, metadata) => {
    if (error instanceof V3DeferredError) return {afterSeconds: 12};
    return {afterSeconds: Math.min(300, 25 * 2 ** Math.min(metadata.deliveryCount, 4))};
  },
});
