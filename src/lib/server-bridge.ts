import { normalizeStatus, type AlexiosStatus, type PowerAction } from "@/lib/alexios";
import { readStatus, changePower } from "@/lib/agent-service";

export class BridgeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export function jsonError(error: unknown): Response {
  const status = error instanceof BridgeError ? error.status : 503;
  const message = error instanceof BridgeError ? error.message : "Falha no servidor Alexios.";
  return Response.json({ error: message }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

async function verifyBearer(request: Request, secret: string | undefined, name: string) {
  if (!secret || secret.length < 24) {
    throw new BridgeError(503, `Token de ${name} não configurado.`);
  }
  const value = request.headers.get("authorization") ?? "";
  const provided = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!provided) throw new BridgeError(401, "Chave de acesso necessária.");

  const digest = async (candidate: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)));
  const [expected, supplied] = await Promise.all([digest(secret), digest(provided)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected[index] ^ supplied[index];
  }
  if (difference !== 0) throw new BridgeError(401, "Chave de acesso inválida.");
}

export async function requireDashboardAuth(request: Request): Promise<void> {
  return verifyBearer(request, process.env.ALEXIOS_DASHBOARD_TOKEN, "painel");
}

export async function requireAgentAuth(request: Request): Promise<void> {
  return verifyBearer(request, process.env.ALEXIOS_AGENT_TOKEN, "Agent");
}

export async function fetchAlexiosStatus(): Promise<AlexiosStatus> {
  return normalizeStatus(await readStatus());
}

export async function sendPowerCommand(action: PowerAction, requestId: string): Promise<void> {
  await changePower(action, requestId);
}
