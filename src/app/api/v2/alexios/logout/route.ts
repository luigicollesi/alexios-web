import { NextResponse } from "next/server";
import { DASHBOARD_COOKIE, logoutDashboard } from "@/lib/v2/dashboard-auth";
import { errorResponse } from "@/lib/v2/http";
import { AgentError } from "@/lib/agent-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new AgentError(403, "Origem invalida.");
    }
    await logoutDashboard(request);
    const response = NextResponse.json({ ok: true }, {
      headers: { "Cache-Control": "no-store" },
    });
    response.cookies.set(DASHBOARD_COOKIE, "", {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "strict", path: "/", maxAge: 0,
    });
    return response;
  } catch (error) { return errorResponse(error); }
}
