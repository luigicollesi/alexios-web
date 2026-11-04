import { dashboardAgent } from "@/lib/v2/dashboard-auth";
import { statusV2 } from "@/lib/v2/agent-service";
import { errorResponse } from "@/lib/v2/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const agentId = await dashboardAgent(request);
    return Response.json(await statusV2(agentId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return errorResponse(error); }
}
