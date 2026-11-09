import { dashboardAgent } from "@/lib/v2/dashboard-auth";
import { statusV2 } from "@/lib/v2/agent-service";
import { AgentError } from "@/lib/agent-db";
import { errorResponse } from "@/lib/v2/http";
import { cartesiaSpeechStream, CartesiaTtsError } from "@/lib/tts/cartesia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authorized dashboard can synthesize ONLY the current, recent speech
 * published by the server; accepting arbitrary transcript text would make
 * this a paid public TTS proxy. Keys remain server-only.
 */
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new AgentError(403, "Origem inválida.");
    }
    const agentId = await dashboardAgent(request);
    const raw = await request.text();
    if (raw.length > 1024) throw new AgentError(413, "Requisição muito grande.");
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { throw new AgentError(400, "JSON inválido."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AgentError(400, "Requisição inválida.");
    }
    const { sequence, activityEpoch } = body as Record<string, unknown>;
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 1 ||
        !Number.isSafeInteger(activityEpoch) || Number(activityEpoch) < 0) {
      throw new AgentError(400, "Identificadores de resposta inválidos.");
    }

    const status = await statusV2(agentId);
    if (!status.agent.connected || status.core.power !== "running" ||
        status.core.protocolVersion !== 3) {
      throw new AgentError(409, "Núcleo V3 indisponível.");
    }
    const speech = status.core.speech;
    if (speech.seq !== sequence || status.conversation?.activityEpoch !== activityEpoch) {
      throw new AgentError(409, "Resposta substituída por atividade mais recente.");
    }
    const at = speech.at ? Date.parse(String(speech.at)) : NaN;
    if (!Number.isFinite(at) || at > Date.now() + 5_000 ||
        Date.now() - at > 12_000 || !speech.text.trim()) {
      throw new AgentError(409, "Resposta não disponível para síntese.");
    }
    const text = speech.text.slice(0, 600).trim();
    const stream = await cartesiaSpeechStream(text, request.signal);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Audio-Encoding": "pcm_f32le",
        "X-Audio-Sample-Rate": "44100",
      },
    });
  } catch (error) {
    if (error instanceof CartesiaTtsError) {
      return errorResponse(new AgentError(error.status, error.message));
    }
    return errorResponse(error);
  }
}
