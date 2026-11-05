import { NextResponse } from "next/server";
import { authorizeDashboard, DASHBOARD_COOKIE, logoutDashboard } from "@/lib/v2/dashboard-auth";
import { errorResponse } from "@/lib/v2/http";
import { AgentError } from "@/lib/agent-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new AgentError(403, "Origem de acesso invalida.");
    }
    const raw = await request.text();
    if (raw.length > 1024) throw new AgentError(413, "Requisicao muito grande.");
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { throw new AgentError(400, "JSON invalido."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AgentError(400, "JSON invalido.");
    }
    // Vercel overwrites forwarded IP headers to mitigate spoofing.
    const source = request.headers.get("x-vercel-forwarded-for") ??
      request.headers.get("x-forwarded-for") ?? "unknown";
    const { token, maxAge } = await authorizeDashboard(
      (body as Record<string, unknown>).instanceId, source,
    );
    // On switching instances, revoke the previous browser session.
    await logoutDashboard(request);
    const response = NextResponse.json({ authorized: true }, {
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(DASHBOARD_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "strict", path: "/", maxAge,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
