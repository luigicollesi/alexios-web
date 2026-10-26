import { requireAgentAuth, BridgeError } from "@/lib/server-bridge";
import { networkError, pollAgent, reportState, saveTranscription, analyzeContext } from "@/lib/agent-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Includes the optional OpenRouter inference (up to 90 seconds).
export const maxDuration = 120;

type Context = { params: Promise<{ path: string[] }> };

async function jsonBody(request: Request): Promise<unknown> {
  // Limit incoming metadata; raw audio is never accepted.
  const raw = await request.text();
  if (raw.length > 128_000) throw new BridgeError(413, "Requisição muito grande.");
  try { return JSON.parse(raw) as unknown; }
  catch { throw new BridgeError(400, "JSON inválido."); }
}

function cleanJson(result: unknown, status = 200) {
  return Response.json(result, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

async function dispatch(request: Request, context: Context) {
  try {
    await requireAgentAuth(request);
    const { path: parts } = await context.params;
    const path = parts?.join("/") || "";

    if (request.method === "GET" && path === "agent/poll") {
      const url = new URL(request.url);
      return cleanJson(await pollAgent(
        url.searchParams.get("instanceId"),
        Number(url.searchParams.get("after") ?? "-1"),
        Number(url.searchParams.get("speechAfter") ?? "-1"),
        request.signal,
      ));
    }
    if (request.method === "POST" && path === "agent/state") {
      return cleanJson(await reportState(await jsonBody(request)));
    }
    if (request.method === "POST" && path === "transcript") {
      return cleanJson(await saveTranscription(await jsonBody(request)), 202);
    }
    if (request.method === "POST" && path === "agent/analyze") {
      const body = await jsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new BridgeError(400, "Requisição inválida.");
      }
      return cleanJson(await analyzeContext((body as Record<string, unknown>).instanceId), 202);
    }
    return cleanJson({ error: "Endpoint inexistente." }, 404);
  } catch (error) {
    if (error instanceof BridgeError) {
      return cleanJson({ error: error.message }, error.status);
    }
    return networkError(error);
  }
}

export async function GET(request: Request, context: Context) {
  return dispatch(request, context);
}

export async function POST(request: Request, context: Context) {
  return dispatch(request, context);
}
