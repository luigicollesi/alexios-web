import {handleCallback, send} from "@vercel/queue";
import {query} from "@/lib/agent-db";
import {processEventV3, V3DeferredError} from "@/lib/v3/event-processor";

export const runtime = "nodejs";
export const maxDuration = 120;

type NextEvent = {event_id: string};

/**
 * The provider queue does not guarantee FIFO, and deferred deliveries
 * are deliberately deprioritized. Neon is the authoritative cursor.
 * After any event is processed, wake precisely the next event in that
 * instance's sequence, even if its original queue delivery occurred early.
 */
async function nextPendingEventV3(previousEventId: string): Promise<string | null> {
  const rows = await query<NextEvent>(
    `SELECT following.event_id
     FROM public.alexios_v3_events previous
     JOIN public.alexios_v3_streams stream
       ON stream.agent_id = previous.agent_id
     JOIN public.alexios_v3_events following
       ON following.agent_id = previous.agent_id
      AND following.sequence = stream.last_processed_sequence + 1
     WHERE previous.event_id = $1::uuid
       AND following.status IN ('pending', 'running')
     LIMIT 1`,
    [previousEventId],
  );
  return rows[0]?.event_id ?? null;
}

// Private Vercel Queue consumer; no public HTTP access to this route.
export const POST = handleCallback(async (message: unknown) => {
  if (!message || typeof message !== "object" ||
      !("eventId" in message) || typeof message.eventId !== "string") {
    throw new Error("Mensagem V3 inválida.");
  }

  const eventId = message.eventId;
  await processEventV3(eventId);

  // Delivery order cannot drive the conversational order. Successful
  // completion (or an already-finished redelivery) signals the next
  // sequential event to make progress. A separate idempotency key is
  // essential: the original message may already have been acknowledged,
  // delivered too early, or be in exponential retry backoff.
  const nextEventId = await nextPendingEventV3(eventId);
  if (nextEventId) {
    await send("alexios-events-v3", {eventId: nextEventId}, {
      idempotencyKey: "v3-drain-" + eventId,
      delaySeconds: 1,
    });
    console.info("[Alexios V3] próximo evento reativado", {
      previousEventId: eventId,
      nextEventId,
    });
  }
}, {
  retry: (error, metadata) => {
    if (error instanceof V3DeferredError) return {afterSeconds: 12};
    return {afterSeconds: Math.min(300, 25 * 2 ** Math.min(metadata.deliveryCount, 4))};
  },
});
