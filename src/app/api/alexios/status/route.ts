import { fetchAlexiosStatus, jsonError, requireDashboardAuth } from "@/lib/server-bridge";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireDashboardAuth(request);
    const status = await fetchAlexiosStatus();
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
