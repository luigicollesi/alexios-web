import { dashboardAgent } from "@/lib/v2/dashboard-auth";
import { powerV2 } from "@/lib/v2/agent-service";
import { errorResponse } from "@/lib/v2/http";
import { AgentError } from "@/lib/agent-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).origin !== new URL(request.url).origin) {
      throw new AgentError(403, "Origem invalida.");
    }
    const agentId = await dashboardAgent(request);
    const raw = await request.text();
    if (raw.length > 2048) throw new AgentError(413, "Requisicao muito grande.");
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentError(400, "JSON invalido.");
    const { action, requestId } = body as Record<string, unknown>;
    if ((action !== "start" && action !== "stop") ||
        typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(requestId)) {
      throw new AgentError(400, "Comando invalido.");
    }
    return Response.json(await powerV2(agentId, action, requestId), {
      status: 202, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return errorResponse(error); }
}
