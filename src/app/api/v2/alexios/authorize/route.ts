import { NextResponse } from "next/server";
import { authorizeDashboard, DASHBOARD_COOKIE } from "@/lib/v2/dashboard-auth";
import { errorResponse } from "@/lib/v2/http";
import { AgentError } from "@/lib/agent-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 1024) throw new AgentError(413, "Requisicao muito grande.");
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AgentError(400, "JSON invalido.");
    }
    const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { token, maxAge } = await authorizeDashboard(
      (body as Record<string, unknown>).instanceId,
      source,
    );
    const response = NextResponse.json({ authorized: true }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(DASHBOARD_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "strict", path: "/", maxAge,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
