/** Pure queue-drain orchestration. Neon cursor controls order; queue delivery may not. */
export async function wakeNextPendingV3(
  previousEventId: string,
  lookup: (previousEventId: string) => Promise<string | null>,
  publish: (eventId: string, idempotencyKey: string) => Promise<void>,
): Promise<string | null> {
  const nextEventId = await lookup(previousEventId);
  if (!nextEventId) return null;

  // Unlike the original publish keyed by the new event's id, a different
  // key avoids deduplicating the recovery message against an old delivery
  // that may already have exhausted retries or fired out of order.
  const key = "v3-drain-" + previousEventId;
  await publish(nextEventId, key);
  return nextEventId;
}
