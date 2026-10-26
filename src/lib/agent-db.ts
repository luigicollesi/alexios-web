import "server-only";
import { neon } from "@neondatabase/serverless";

export type AgentPower = "running" | "stopped" | "starting" | "stopping";
export type AgentPose = "idle" | "listening" | "thinking" | "speaking";
export type Word = { text: string; startMs: number; endMs: number };
export type Capture = { id: string; index: number; lastEndMs: number; tail: { text: string; endMs: number }[] };

export interface AgentSession {
  session_id: string;
  instance_id: string | null;
  last_poll_at: string | null;
  power: AgentPower;
  desired_power: "running" | "stopped";
  command_seq: string | number;
  speech_seq: string | number;
  speech_text: string;
  speech_at: string | null;
  expression_id: AgentPose;
  context_text: string;
  pending_words: Word[];
  inference_words: Word[];
  capture: Capture | null;
  blocked_capture_id: string | null;
  epoch: string | number;
  version: string | number;
  inference_token: string | null;
  inference_started_at: string | null;
  last_ai_at: string | null;
  last_error: string | null;
}

export class AgentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export function connection() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new AgentError(503, "DATABASE_URL não configurada na Vercel.");
  return neon(url);
}

export async function query<T>(statement: string, values: unknown[] = []): Promise<T[]> {
  const sql = connection();
  return await sql.query(statement, values) as T[];
}

export async function session(): Promise<AgentSession> {
  const rows = await query<AgentSession>("SELECT * FROM public.alexios_sessions WHERE session_id = 'primary'");
  if (!rows[0]) throw new AgentError(503, "Banco de dados não inicializado. Execute a migração.");
  return rows[0];
}

export function leaseIsFresh(value: string | null): boolean {
  const date = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(date) && date <= Date.now() + 5_000 && Date.now() - date < 45_000;
}

export function assertInstance(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
    throw new AgentError(400, "instanceId inválido.");
  }
}

export function assertLease(row: AgentSession, instanceId: string) {
  if (row.instance_id !== instanceId || !leaseIsFresh(row.last_poll_at)) {
    throw new AgentError(409, "Lease do Agent indisponível ou vencida.");
  }
}

export function numeric(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}
