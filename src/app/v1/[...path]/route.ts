import { BridgeError, jsonError } from "@/lib/server-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long polls wait up to 20 seconds in the durable hub.
export const maxDuration = 35;

type Context = { params: Promise<{ path: string[] }> };

const API_ROUTES = {
  "agent/poll": "GET",
  "agent/state": "POST",
  transcript: "POST",
} as const;

async function checkAgentToken(request: Request, token: string): Promise<void> {
  if (token.length < 24) {
    throw new BridgeError(503, "Token do Agent não configurado.");
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) throw new BridgeError(401, "Autenticação do Agent necessária.");

  // Compare fixed-length digests, not the raw token values.
  const digest = async (value: string): Promise<Uint8Array<ArrayBuffer>> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [expected, actual] = await Promise.all([digest(token), digest(provided)]);
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected[index] ^ actual[index];
  }
  if (diff !== 0) throw new BridgeError(401, "Token do Agent inválido.");
}

function targetUrl(request: Request, path: string): { url: URL; token: string } {
  const address = process.env.ALEXIOS_API_BASE_URL;
  const token = process.env.ALEXIOS_AGENT_TOKEN;
  if (!address || !token) {
    throw new BridgeError(503, "Agent Hub não configurado na Vercel.");
  }

  let base: URL;
  try {
    base = new URL(address.endsWith("/") ? address : address + "/");
  } catch {
    throw new BridgeError(503, "ALEXIOS_API_BASE_URL inválida.");
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw new BridgeError(503, "O Agent Hub deve utilizar HTTPS em produção.");
  }
  if (base.origin === new URL(request.url).origin) {
    throw new BridgeError(503, "Agent Hub não pode apontar para o próprio Alexios Web.");
  }

  const url = new URL("v1/" + path, base);
  if (path === "agent/poll") {
    url.search = new URL(request.url).search;
  }
  return { url, token };
}

async function relay(request: Request, context: Context): Promise<Response> {
  try {
    const { path: segments } = await context.params;
    const path = Array.isArray(segments) ? segments.join("/") : "";
    const method = API_ROUTES[path as keyof typeof API_ROUTES];
    if (!method || request.method !== method) {
      throw new BridgeError(404, "Rota do Agent inexistente.");
    }

    const { url, token } = targetUrl(request, path);
    await checkAgentToken(request, token);

    let body: string | undefined;
    if (method === "POST") {
      // These endpoints accept JSON transcription metadata, never raw audio.
      body = await request.text();
      if (body.length > 128_000) {
        throw new BridgeError(413, "Transcrição excede o tamanho permitido.");
      }
      try {
        JSON.parse(body);
      } catch {
        throw new BridgeError(400, "JSON inválido.");
      }
    }

    const upstream = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    // Preserve 2xx/4xx statuses and JSON payloads for client retries and leases.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(request: Request, context: Context) {
  return relay(request, context);
}

export async function POST(request: Request, context: Context) {
  return relay(request, context);
}
