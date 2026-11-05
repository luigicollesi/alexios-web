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
      return Response.json(await syncV3(body), {headers: {"Cache-Control": "no-store"}});
    }
    if (path === "agent/activity") {
      return Response.json(await activityV3(body), {headers: {"Cache-Control": "no-store"}});
    }
    const kind: V3EventKind | undefined = path === "agent/turn" ? "turn_end"
      : path === "agent/chunk" ? "turn_chunk"
      : path === "agent/floor" ? "floor_open" : undefined;
    if (!kind) throw new AgentError(404, "Endpoint V3 desconhecido.");
    const ack = await acceptV3Event(body, kind);
    // The DB is authoritative. The queue is a wake-up signal and can redeliver.
    // Retry of an accepted event reuses the same eventId and queue idempotency key.
    await send("alexios-events-v3", {eventId: ack.eventId}, {
      idempotencyKey: ack.eventId, delaySeconds: 1,
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
