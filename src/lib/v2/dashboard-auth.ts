import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AgentError, query } from "@/lib/agent-db";
import { connected, findInstance, sessionFor, keyedDigest } from "@/lib/v2/agent-service";

export const DASHBOARD_COOKIE = "alexios_dashboard_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const UNAUTHORIZED = "Identificador invalido ou instancia desconectada.";

function cookieHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function authorizeDashboard(instanceId: unknown, source: string) {
  // Atomic rolling-window counters prevent concurrent guessing from bypassing the limit.
  const sourceHash = keyedDigest("login-source:" + source);
  const attempts = await query<{ attempts: number | string }>(
    `INSERT INTO public.alexios_auth_rate_limits(source_hash, attempts, window_started_at)
      VALUES ($1, 1, now())
      ON CONFLICT (source_hash) DO UPDATE SET
        attempts = CASE WHEN alexios_auth_rate_limits.window_started_at <
          now() - interval '5 minutes'
          THEN 1 ELSE alexios_auth_rate_limits.attempts + 1 END,
        window_started_at = CASE WHEN alexios_auth_rate_limits.window_started_at <
          now() - interval '5 minutes'
          THEN now() ELSE alexios_auth_rate_limits.window_started_at END
      RETURNING attempts`,
    [sourceHash],
  );
  if (Number(attempts[0]?.attempts ?? 0) > 10) {
    throw new AgentError(429, "Muitas tentativas de acesso. Tente novamente depois.");
  }
  try {
    if (typeof instanceId !== "string") throw new Error("missing");
    const found = await findInstance(instanceId);
    if (!found) throw new Error("unknown");
    const row = await sessionFor(found.id);
    if (!connected(row)) throw new Error("offline");

    const token = randomBytes(32).toString("hex");
    await query(
      `INSERT INTO public.alexios_dashboard_sessions(session_hash, agent_id, expires_at)
        VALUES ($1, $2::uuid, now() + interval '7 days')`,
      [cookieHash(token), found.id],
    );
    return { token, maxAge: SESSION_SECONDS };
  } catch (error) {
    if (error instanceof AgentError && error.status >= 500) throw error;
    throw new AgentError(401, UNAUTHORIZED);
  }
}

export async function dashboardAgent(request: Request): Promise<string> {
  const cookies = request.headers.get("cookie") ?? "";
  const raw = cookies.split(";").map((value) => value.trim()).find((value) =>
    value.startsWith(DASHBOARD_COOKIE + "="));
  const token = raw?.slice(DASHBOARD_COOKIE.length + 1);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    throw new AgentError(401, "Painel nao autorizado.");
  }
  const rows = await query<{agent_id:string}>(
    `SELECT agent_id FROM public.alexios_dashboard_sessions
      WHERE session_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [cookieHash(token)],
  );
  if (!rows[0]) throw new AgentError(401, "Sessao de acesso expirada.");
  return rows[0].agent_id;
}

export async function logoutDashboard(request: Request): Promise<void> {
  const cookies = request.headers.get("cookie") ?? "";
  const raw = cookies.split(";").map((value) => value.trim()).find((value) =>
    value.startsWith(DASHBOARD_COOKIE + "="));
  const token = raw?.slice(DASHBOARD_COOKIE.length + 1);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await query(
      `UPDATE public.alexios_dashboard_sessions SET revoked_at = now()
        WHERE session_hash = $1 AND revoked_at IS NULL`,
      [cookieHash(token)],
    );
  }
}
