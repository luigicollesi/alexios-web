import { fetchAlexiosStatus, jsonError, requireDashboardAuth, sendPowerCommand, BridgeError } from "@/lib/server-bridge";
import type { PowerAction } from "@/lib/alexios";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireDashboardAuth(request);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BridgeError(400, "Requisição inválida.");
    }
    const { action, requestId } = body as Record<string, unknown>;
    if ((action !== "start" && action !== "stop") ||
        typeof requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(requestId)) {
      throw new BridgeError(400, "Comando de energia inválido.");
    }

    // Recheck the live poll lease on the server; do not trust UI state alone.
    const status = await fetchAlexiosStatus();
    if (!status.agent.connected) {
      throw new BridgeError(409, "Nenhum Agent conectado por long polling.");
    }
    const expected = action === "start" ? "stopped" : "running";
    if (status.core.power !== expected) {
      throw new BridgeError(409, "O estado do Core mudou. Atualize o painel.");
    }

    await sendPowerCommand(action as PowerAction, requestId);
    // 202 means the command was accepted, NOT that the process has changed state.
    return Response.json({ accepted: true, requestId }, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
