import {dashboardAgent} from "@/lib/v2/dashboard-auth";
import {errorResponse} from "@/lib/v2/http";
import {AgentError} from "@/lib/agent-db";
import {updatePlaybackV3, type PlaybackAction} from "@/lib/v3/playback-service";
import {validUuid} from "@/lib/v3/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new AgentError(403, "Origem inválida.");
    }
    const agentId = await dashboardAgent(request);
    const raw = await request.text();
    if (raw.length > 600) throw new AgentError(413, "Requisição muito grande.");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new AgentError(400, "JSON inválido."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AgentError(400, "Corpo inválido.");
    }
    const data = parsed as Record<string, unknown>;
    const action = data.action as PlaybackAction;
    if ((action !== "start" && action !== "pulse" && action !== "finish") ||
        !validUuid(data.playbackId) ||
        typeof data.speechSeq !== "number" ||
        !Number.isSafeInteger(data.speechSeq) || data.speechSeq < 1) {
      throw new AgentError(400, "Identificação do áudio inválida.");
    }
    const accepted = await updatePlaybackV3(agentId, data.playbackId, data.speechSeq, action);
    if (!accepted) throw new AgentError(409, "Resposta ou execução não está mais ativa.");
    return Response.json({accepted: true}, {
      headers: {"Cache-Control": "no-store"},
    });
  } catch (error) {
    return errorResponse(error);
  }
}
