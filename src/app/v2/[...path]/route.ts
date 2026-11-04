import { requireAgentAuth } from "@/lib/server-bridge";
import { after } from "next/server";
import { analyzePendingV2 } from "@/lib/v2/inference-service";
import { findInstance } from "@/lib/v2/agent-service";
import { AgentError } from "@/lib/agent-db";
import { pollV2, reportStateV2, uploadV2 } from "@/lib/v2/agent-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
      const body = await jsonBody(request);
      const outcome = await uploadV2(body);
      if (outcome.acceptedWords > 0 && body && typeof body === "object" && "instanceId" in body) {
        const agent = await findInstance(String((body as {instanceId: unknown}).instanceId));
        if (agent) {
          after(async () => {
            // O processamento ocorre somente na Vercel, nunca no Python.
            await new Promise((resolve) => setTimeout(resolve, 8_000));
            try { await analyzePendingV2(agent.id); }
            catch (error) { console.error("Analise Alexios V2:", error); }
          });
        }
      }
      return Response.json(outcome, {
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
