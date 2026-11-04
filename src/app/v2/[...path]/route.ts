import { requireAgentAuth } from "@/lib/server-bridge";
import { AgentError } from "@/lib/agent-db";
import { pollV2, reportStateV2, uploadV2 } from "@/lib/v2/agent-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ path: string[] }> };

async function jsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > 128_000) throw new AgentError(413, "Requisicao muito grande.");
  try { return JSON.parse(raw) as unknown; }
  catch { throw new AgentError(400, "JSON invalido."); }
}

async function dispatch(request: Request, context: Context): Promise<Response> {
  try {
    await requireAgentAuth(request);
    const { path } = await context.params;
    const endpoint = path.join("/");
    if (request.method === "POST" && endpoint === "agent/poll") {
      return Response.json(await pollV2(await jsonBody(request), request.signal), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method === "POST" && endpoint === "agent/state") {
      return Response.json(await reportStateV2(await jsonBody(request)), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method === "POST" && endpoint === "transcript") {
      return Response.json(await uploadV2(await jsonBody(request)), {
        status: 202, headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json({ error: "Rota inexistente." }, { status: 404 });
  } catch (error) {
    const status = error instanceof AgentError ? error.status : 503;
    const message = error instanceof Error ? error.message : "Falha na API.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function POST(request: Request, context: Context) {
  return dispatch(request, context);
}
