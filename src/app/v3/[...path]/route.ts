import {after} from "next/server";
import {fastLaneEnabled} from "@/lib/v3/fast-protocol";
import {processFastFloorV3} from "@/lib/v3/fast-response";
import {send} from "@vercel/queue";
import {requireAgentAuth} from "@/lib/server-bridge";
import {AgentError} from "@/lib/agent-db";
import {activityV3, acceptV3Event, syncV3} from "@/lib/v3/agent-service";
import type {V3EventKind} from "@/lib/v3/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = {params: Promise<{path: string[]}>};

async function jsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > 16_000) throw new AgentError(413, "Evento V3 muito grande.");
  try { return JSON.parse(raw) as unknown; }
  catch { throw new AgentError(400, "JSON inválido."); }
}

export async function POST(request: Request, context: Context) {
  try {
    await requireAgentAuth(request);
    const path = (await context.params).path.join("/");
    const body = await jsonBody(request);
    if (path === "agent/sync") {
      const result = await syncV3(body);
      if (result.recoveryEventId) {
        // Trigger recovery even if the original queue delivery was exhausted.
        // A distinct delivery is safe: claim() and the Neon sequence are atomic.
        try {
          await send("alexios-events-v3", {eventId: result.recoveryEventId}, {
            delaySeconds: 0,
          });
          console.info("[Alexios V3] recuperação reativada", {
            eventId: result.recoveryEventId,
          });
        } catch (error) {
          console.error("[Alexios V3] falha ao reativar evento pendente", {
            reason: error instanceof Error ? error.name : "unknown",
          });
          // Sync must not take down the microphone if the queue is unavailable.
        }
      }
      console.info("[Alexios V3] sync aceito", {nextSequence: result.nextSequence});
      return Response.json(
        {nextSequence: result.nextSequence},
        {headers: {"Cache-Control": "no-store"}},
      );
    }
    if (path === "agent/activity") {
      const result = await activityV3(body);
      console.info("[Alexios V3] speech_started aceito");
      return Response.json(result, {headers: {"Cache-Control": "no-store"}});
    }
    const kind: V3EventKind | undefined = path === "agent/turn" ? "turn_end"
      : path === "agent/chunk" ? "turn_chunk"
      : path === "agent/floor" ? "floor_open" : undefined;
    if (!kind) throw new AgentError(404, "Endpoint V3 desconhecido.");
    const ack = await acceptV3Event(body, kind);
    // The DB is authoritative. The queue is a wake-up signal and can redeliver.
    // Retry of an accepted event reuses the same eventId and queue idempotency key.
    await send("alexios-events-v3", {eventId: ack.eventId}, {
      idempotencyKey: ack.eventId, delaySeconds: 0,
    });
    if (kind === "floor_open" && fastLaneEnabled() && !ack.ignored) {
      // HTTP 202 immediately acknowledges durable intake. Inference runs
      // after the response; the V3 queue remains a durable recovery path.
      after(async () => {
        await processFastFloorV3(ack.eventId);
        // The queue's original floor delivery may have arrived too early
        // and been deferred. Reawaken it so the Neon cursor does not
        // stay stalled for the full retry interval.
        try {
          await send("alexios-events-v3", {eventId: ack.eventId}, {
            idempotencyKey: "v3-fast-finished-" + ack.eventId,
            delaySeconds: 0,
          });
        } catch (error) {
          console.warn("[Alexios V3 FAST] nao foi possivel reativar cursor", {
            eventId: ack.eventId,
            reason: error instanceof Error ? error.name : "unknown",
          });
        }
      });
    }
    console.info("[Alexios V3] evento aceito", {
      kind, eventId: ack.eventId, duplicate: ack.duplicate,
      ignoredDuringPlayback: ack.ignored,
    });
    return Response.json({accepted: true}, {
      status: 202, headers: {"Cache-Control": "no-store"},
    });
  } catch (error) {
    const known = error instanceof AgentError;
    const status = known ? error.status : error instanceof SyntaxError
      || error instanceof TypeError || (error instanceof Error &&
      /inválid[oa]|obrigatóri[oa]/i.test(error.message)) ? 400 : 503;
    // Never return DB/secret/provider implementation details in public errors.
    const message = known ? error.message : status === 400
      ? (error as Error).message : "Falha temporária no Alexios V3.";
    return Response.json({error: message}, {
      status, headers: {"Cache-Control": "no-store"},
    });
  }
}
