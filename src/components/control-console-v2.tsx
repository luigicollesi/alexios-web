"use client";

import {
  Activity, ArrowDownRight, ArrowUpRight, Check, CircleDot, Cpu,
  Headphones, LockKeyhole, Power, Radio, ShieldCheck, Volume2, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  derivePowerView, EXPRESSION_LABELS, normalizeStatus,
  type AlexiosStatus, type ExpressionId, type PowerAction,
} from "@/lib/alexios";

const API_STATUS = "/api/v2/alexios/status";
const API_AUTHORIZE = "/api/v2/alexios/authorize";
const API_LOGOUT = "/api/v2/alexios/logout";
const API_POWER = "/api/v2/alexios/power";
const SCALE_BASE_WIDTH = 1600;
const SCALE_BASE_HEIGHT = 900;

function formatPoll(value: string | null) {
  if (!value) return "--:--:--";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "--:--:--";
  return new Date(time).toLocaleTimeString("pt-BR", { hour12: false });
}

function statusCopy(view: ReturnType<typeof derivePowerView>) {
  switch (view) {
    case "running":
      return { text: "NÚCLEO ATIVO", detail: "PROCESSO EM EXECUÇÃO", color: "red" };
    case "stopped":
      return { text: "NÚCLEO EM REPOUSO", detail: "AGENT DISPONÍVEL", color: "green" };
    case "transitioning":
      return { text: "TRANSIÇÃO", detail: "AGUARDANDO CONFIRMAÇÃO", color: "neutral" };
    default:
      return { text: "SEM CONEXÃO", detail: "AGUARDANDO LONG POLLING", color: "neutral" };
  }
}

function Character({ expression, connected }: { expression: ExpressionId; connected: boolean }) {
  const source = "/characters/" + expression + ".png";
  return (
    <div className={"character-slot " + (connected ? "is-connected" : "is-disconnected")}>
      {/* The SVG is an original placeholder. Add transparent full-body PNGs to public/characters. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={source}
        className="character-img"
        src={source}
        alt={"Alexios em postura " + EXPRESSION_LABELS[expression].toLowerCase()}
        draggable={false}
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.src.endsWith("/characters/placeholder.svg")) {
            image.src = "/characters/placeholder.svg";
          }
        }}
      />
      <div className="character-shadow" aria-hidden="true" />
    </div>
  );
}

export function ControlConsoleV2() {
  const [scale, setScale] = useState(1);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AlexiosStatus | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [pending, setPending] = useState<PowerAction | null>(null);

  useEffect(() => {
    const resize = () => {
      setScale(Math.min(window.innerWidth / SCALE_BASE_WIDTH, window.innerHeight / SCALE_BASE_HEIGHT));
    };
    resize();
    window.addEventListener("resize", resize, { passive: true });
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    let mounted = true;
    void fetch(API_STATUS, { credentials: "same-origin", cache: "no-store" })
      .then((response) => { if (mounted) setAuthorized(response.ok); })
      .catch(() => { if (mounted) setAuthorized(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (authorized !== true) return;
    const controller = new AbortController();
    let inFlight = false;
    let mounted = true;

    const poll = async () => {
      if (inFlight || !mounted) return;
      inFlight = true;
      try {
        const response = await fetch(API_STATUS, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (mounted) {
            setAuthorized(false);
            setSnapshot(null);
            setApiAvailable(false);
            setPending(null);
            setConnectionError("Sessão expirada. Autorize uma instância novamente.");
            setLoginOpen(true);
          }
          return;
        }
        if (!response.ok) {
          const data: unknown = await response.json().catch(() => null);
          const error = data && typeof data === "object" && "error" in data
            ? String((data as { error: unknown }).error)
            : "Falha ao consultar o Agent.";
          throw new Error(error);
        }
        const raw: unknown = await response.json();
        if (mounted) {
          const freshStatus = normalizeStatus(raw);
          setSnapshot(freshStatus);
          setPending((current) => {
            if (current === "start" && freshStatus.core.power === "running") return null;
            if (current === "stop" && freshStatus.core.power === "stopped") return null;
            return current;
          });
          setApiAvailable(true);
          setConnectionError(null);
        }
      } catch (error) {
        if (mounted && !controller.signal.aborted) {
          setSnapshot(null);
          setApiAvailable(false);
          setConnectionError(error instanceof Error ? error.message : "Comunicação indisponível.");
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 3_500);
    return () => {
      mounted = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [authorized]);

  const powerView = derivePowerView(snapshot);
  const live = powerView !== "offline";
  const expression = snapshot?.core.expressionId ?? "idle";
  const labels = statusCopy(powerView);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      setPending(null);
      setCommandError("Comando sem confirmação. Consulte o estado do Core antes de tentar novamente.");
    }, 18_000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const submitAccess = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tokenDraft.trim()) return;
    setConnectionError(null);
    setCommandError(null);
    try {
      const response = await fetch(API_AUTHORIZE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: tokenDraft.trim() }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : "Não foi possível autorizar esta instância.";
        throw new Error(message);
      }
      setSnapshot(null);
      setApiAvailable(false);
      setPending(null);
      setAuthorized(true);
      setTokenDraft("");
      setLoginOpen(false);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Falha na autorização.");
    }
  }, [tokenDraft]);

  const logoutPanel = useCallback(async () => {
    try {
      const response = await fetch(API_LOGOUT, {
        method: "POST", credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Nao foi possivel desvincular a sessao.");
      setAuthorized(false);
      setSnapshot(null);
      setPending(null);
      setApiAvailable(false);
      setTokenDraft("");
      setLoginOpen(false);
      setConnectionError(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Falha ao sair.");
    }
  }, []);

  const sendPower = useCallback(async () => {
    if (!authorized || pending || (powerView !== "running" && powerView !== "stopped")) return;
    const action: PowerAction = powerView === "running" ? "stop" : "start";
    setPending(action);
    setCommandError(null);
    try {
      const response = await fetch(API_POWER, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId: crypto.randomUUID() }),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const message = data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : "O comando não foi aceito pelo Agent.";
        throw new Error(message);
      }
      // A 202 is merely accepted. The UI stays pending until a subsequent status confirms it.
    } catch (error) {
      setPending(null);
      setCommandError(error instanceof Error ? error.message : "Erro ao enviar comando.");
    }
  }, [authorized, pending, powerView]);

  const powerLabel = useMemo(() => {
    if (pending === "stop") return "ENCERRANDO";
    if (pending === "start") return "INICIANDO";
    if (powerView === "running") return "FIM";
    if (powerView === "stopped") return "INICIAR";
    if (powerView === "transitioning") return "EM TRANSIÇÃO";
    return "SEM SINAL";
  }, [pending, powerView]);

  const statusText = authorized === null ? "VALIDANDO ACESSO" :
    !authorized ? "NÃO AUTORIZADO" : apiAvailable ? "LINK AUTORIZADO" : "LINK INDISPONÍVEL";
  const stageStyle = { "--console-scale": scale } as CSSProperties;

  return (
    <main className="viewport">
      <div className="world-grid" aria-hidden="true" />
      <div className="console-stage" style={stageStyle}>
        <div className="stage-noise" aria-hidden="true" />
        <div className="stage-graticule" aria-hidden="true" />
        <span className="edge-corner edge-corner-tl" aria-hidden="true" />
        <span className="edge-corner edge-corner-tr" aria-hidden="true" />
        <span className="edge-corner edge-corner-bl" aria-hidden="true" />
        <span className="edge-corner edge-corner-br" aria-hidden="true" />

        <header className="topbar">
          <div className="brand-mark" aria-hidden="true"><span>A</span><i /></div>
          <div className="brand-copy">
            <span className="brand-name">ALEXIOS<span className="brand-stop">.</span></span>
            <span className="brand-caption">INTELLIGENCE CONTROL SYSTEM</span>
          </div>
          <div className="header-divider" />
          <div className="header-environment"><CircleDot size={13} /><span>CORE INTERFACE <b>01</b></span></div>
          <div className="header-spacer" />
          <div className={"header-connection " + (apiAvailable ? "connected" : "")}>
            <span className="small-led" />
            <span>{statusText}</span>
          </div>
          <button className="access-button" onClick={() => setLoginOpen(true)} type="button">
            <LockKeyhole size={15} strokeWidth={1.8} />
            {authorized ? "ALTERAR ACESSO" : "AUTORIZAR ACESSO"}
            <ArrowUpRight size={14} />
          </button>
        </header>

        <div className="top-ruler" aria-hidden="true"><span>01 / SYSTEM OVERVIEW</span><span>REMOTE INTELLIGENCE // A-01</span></div>

        <aside className="info-panel left-panel" aria-label="Estado da conexão">
          <div className="section-caption"><span className="section-line" />LINK DE CONTROLE <span className="section-index">/01</span></div>
          <div className="panel-heading">CONEXÃO<span className="muted-dot">.</span></div>
          <div className="panel-description">Canal seguro de comunicação com o agente local.</div>
          <div className="glass-strip">
            <div className="strip-icon"><Radio size={22} strokeWidth={1.3} /></div>
            <div>
              <div className="mini-label">AGENT STATUS</div>
              <div className={"strip-value " + (live ? "available" : "")}>
                {live ? "CONECTADO" : "DESCONECTADO"}
              </div>
            </div>
            <div className={"signal-waves " + (live ? "active" : "")}><i /><i /><i /><i /></div>
          </div>
          <div className="panel-metrics">
            <div className="metric-row"><span><Activity size={14} /> LONG POLLING</span><strong>{live ? "ATIVO" : "INATIVO"}</strong></div>
            <div className="metric-row"><span><ShieldCheck size={14} /> SERVIÇO API</span><strong>{apiAvailable ? "ONLINE" : "--"}</strong></div>
            <div className="metric-row"><span><CircleDot size={14} /> ÚLTIMO POLL</span><strong>{formatPoll(snapshot?.agent.lastPollAt ?? null)}</strong></div>
          </div>
          <div className="left-technical">
            <span className="tech-kicker">CONNECTION PROTOCOL</span>
            <span>HTTPS / LONG-POLL</span>
            <div className="technical-line" /><div className="technical-line short" />
            <span className="technical-id">LOCAL AGENT {authorized ? "VINCULADO" : "—"}</span>
          </div>
        </aside>

        <section className="hero-panel" aria-label="Representação visual do Alexios">
          <div className="hero-backtitle" aria-hidden="true">ALEXIOS</div>
          <div className="hero-orbit orbit-external" aria-hidden="true" />
          <div className="hero-orbit orbit-internal" aria-hidden="true" />
          <div className="orbit-ticks" aria-hidden="true" />
          <div className="orbit-crosshair orbit-crosshair-l" aria-hidden="true">+</div>
          <div className="orbit-crosshair orbit-crosshair-r" aria-hidden="true">+</div>
          <div className="figure-glow" aria-hidden="true" />
          <Character expression={expression} connected={live} />
          <div className="figure-floor" aria-hidden="true" />
          <div className="hero-data hero-data-left"><span>FIG. A-01</span><span>HUMANOID INTERFACE</span></div>
          <div className="hero-data hero-data-right"><span>COORD / 00.00</span><span>VISUAL SYSTEM ONLINE</span></div>
          <div className="hero-label"><i className={live ? "is-live" : ""} /><span>{EXPRESSION_LABELS[expression]}</span><span className="hero-label-mini">/ EMOTION ID</span></div>
        </section>

        <aside className="info-panel right-panel" aria-label="Estado do núcleo">
          <div className="section-caption"><span className="section-line" />NÚCLEO INTELIGENTE <span className="section-index">/02</span></div>
          <div className="panel-heading">SISTEMA<span className="muted-dot">.</span></div>
          <div className="panel-description">Estado operacional do Alexios Core.</div>
          <div className={"core-status-card status-" + labels.color}>
            <div className="core-status-head"><Cpu size={18} strokeWidth={1.4} /><span>CORE STATE</span><ArrowUpRight size={14} /></div>
            <span className="core-status-title">{labels.text}</span>
            <span className="core-status-detail">{labels.detail}</span>
            <div className="core-status-track"><i /></div>
          </div>
          <div className="panel-metrics right-metrics">
            <div className="metric-row"><span><Headphones size={14} /> VOZ / ESCUTA</span><strong>{powerView === "running" ? "DISPONÍVEL" : "--"}</strong></div>
            <div className="metric-row"><span><Volume2 size={14} /> EXPRESSÃO</span><strong>{snapshot ? EXPRESSION_LABELS[expression] : "--"}</strong></div>
            <div className="metric-row"><span><Power size={14} /> CORE POWER</span><strong>{snapshot?.core.power.toUpperCase() ?? "UNKNOWN"}</strong></div>
          </div>
          <section className="speech-log" aria-label="Última fala do Alexios" aria-live="polite">
            <span className="speech-caption"><Volume2 size={12} /> ÚLTIMA FALA / ALEXIOS</span>
            <p>{snapshot?.core.speech.text || "Nenhuma intervenção até o momento. O Alexios pode optar por permanecer em silêncio."}</p>
            <span className="speech-timestamp">{snapshot?.core.speech.at ? formatPoll(snapshot.core.speech.at) : "AGUARDANDO DECISÃO"}</span>
          </section>
          {snapshot?.core.lastError && <p className="speech-error" role="status">{snapshot.core.lastError}</p>}
          <div className="right-technical"><div className="technical-line" /><div className="technical-line short" /><span>RESPONSE CHANNEL // LIVE</span></div>
        </aside>

        <div className="vertical-rail rail-left" aria-hidden="true"><span>AX // 041.734</span></div>
        <div className="vertical-rail rail-right" aria-hidden="true"><span>NEURAL LINK / LOCAL NETWORK</span></div>

        <section className="power-dock" aria-label="Controle de energia">
          <div className="power-rule"><span /><b>POWER CONTROL</b><span /></div>
          <div className="power-dock-content">
            <div className="power-side-note left">
              <span className="note-symbol"><ArrowDownRight size={20} strokeWidth={1.2} /></span>
              <span>REMOTE<br />OVERRIDE</span>
            </div>
            <div className="power-control">
              <div className={"power-outer power-" + (pending ? "transitioning" : powerView)}>
                <div className="power-bracket bracket-left" /><div className="power-bracket bracket-right" />
                <button
                  type="button"
                  className="power-button"
                  onClick={() => void sendPower()}
                  disabled={!!pending || (powerView !== "running" && powerView !== "stopped")}
                  aria-label={powerView === "running" ? "Desligar Alexios Core" : powerView === "stopped" ? "Ligar Alexios Core" : "Controle de energia indisponível"}
                >
                  <Power size={24} strokeWidth={1.8} />
                  <span>{powerLabel}</span>
                  <span className="button-chevron">/</span>
                </button>
              </div>
              <div className="power-help">
                <span className={"help-light " + (live ? "active" : "")} />
                {pending ? "COMANDO ENVIADO • AGUARDANDO CONFIRMAÇÃO" : live ? "CONTROLE REMOTO HABILITADO" : "CONECTE UM AGENT PARA HABILITAR"}
              </div>
            </div>
            <div className="power-side-note right"><span>TERMINAL<br />OPERATION</span><span className="note-symbol"><Check size={18} strokeWidth={1.2} /></span></div>
          </div>
          {(commandError || connectionError) && (
            <div className="console-error" role="alert"><WifiOff size={13} />{commandError || connectionError}</div>
          )}
        </section>

        <footer className="footerbar"><span>© 2026 BELLUM CIVILE / ALEXIOS PROJECT</span><span>CONTROL UNIT <b>001</b></span><span>DESIGNED FOR CONTINUOUS OPERATION <i /></span></footer>

        {loginOpen && (
          <div className="modal-overlay" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLoginOpen(false);
          }}>
            <form className="access-modal" onSubmit={submitAccess} role="dialog" aria-modal="true" aria-labelledby="access-title">
              <div className="modal-caption">SECURE ACCESS // ALEXIOS</div>
              <button type="button" className="modal-close" aria-label="Fechar" onClick={() => setLoginOpen(false)}><X size={19} /></button>
              <h2 id="access-title">VINCULAR PAINEL<span>.</span></h2>
              <p>Informe o identificador secreto ALEXIOS_INSTANCE_ID da instância conectada. Após a autorização, o navegador recebe uma sessão segura.</p>
              <label htmlFor="access-key">ALEXIOS_INSTANCE_ID</label>
              <input id="access-key" type="password" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="alx_..." autoComplete="off" required autoFocus />
              <button type="submit" className="modal-submit"><LockKeyhole size={16} /> AUTORIZAR CONEXÃO <ArrowUpRight size={16} /></button>
              {authorized && <button type="button" className="modal-submit" onClick={() => void logoutPanel()}>DESVINCULAR PAINEL</button>}
              {connectionError && <span className="modal-error">{connectionError}</span>}
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
