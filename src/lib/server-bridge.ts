import { normalizeStatus, type AlexiosStatus, type PowerAction } from "@/lib/alexios";

export class BridgeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export function jsonError(error: unknown): Response {
  const status = error instanceof BridgeError ? error.status : 502;
  const message = error instanceof BridgeError ? error.message : "Falha na comunicação com o Alexios.";
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function requireDashboardAuth(request: Request): Promise<void> {
  const expected = process.env.ALEXIOS_DASHBOARD_TOKEN;
  if (!expected || expected.length < 24) {
    throw new BridgeError(503, "Acesso não configurado no servidor.");
  }

  const header = request.headers.get("authorization") ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!actual) throw new BridgeError(401, "Informe a chave de acesso ao painel.");

  const hash = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(expected), hash(actual)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  if (diff !== 0) throw new BridgeError(401, "Chave de acesso inválida.");
}

function upstreamConfig(): { base: URL; token: string } {
  const address = process.env.ALEXIOS_API_BASE_URL;
  const token = process.env.ALEXIOS_AGENT_TOKEN;
  if (!address || !token) throw new BridgeError(503, "API do Agent não configurada.");

  let base: URL;
  try {
    base = new URL(address.endsWith("/") ? address : address + "/");
  } catch {
    throw new BridgeError(503, "Endereço da API do Agent inválido.");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw new BridgeError(503, "A API do Agent deve utilizar HTTPS.");
  }
  return { base, token };
}

async function upstream(path: string, init: RequestInit = {}): Promise<unknown> {
  const { base, token } = upstreamConfig();
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new BridgeError(502, "O serviço do Agent recusou a requisição.");
  try {
    return await response.json() as unknown;
  } catch {
    throw new BridgeError(502, "Resposta inválida da API do Agent.");
  }
}

export async function fetchAlexiosStatus(): Promise<AlexiosStatus> {
  return normalizeStatus(await upstream("v1/status"));
}

export async function sendPowerCommand(action: PowerAction, requestId: string): Promise<void> {
  await upstream("v1/power", {
    method: "POST",
    body: JSON.stringify({ action, requestId }),
  });
}
