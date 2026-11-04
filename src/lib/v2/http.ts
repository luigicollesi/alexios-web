import { AgentError } from "@/lib/agent-db";

export function errorResponse(error: unknown): Response {
  const status = error instanceof AgentError ? error.status : 503;
  const detail = error instanceof AgentError ? error.message : "Falha no servidor Alexios.";
  return Response.json({ error: detail }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
