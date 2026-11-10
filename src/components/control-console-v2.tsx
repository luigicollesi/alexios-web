"use client";

import {
  Activity, ArrowUpRight, ChevronDown, CircleDot, Cpu,
  Headphones, LockKeyhole, Power, Radio, ShieldCheck, Volume2, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useAlexiosVoice } from "@/hooks/use-alexios-voice";
import { playbackAvatar } from "@/lib/tts/voice-avatar";
import {avatarPath, avatarForm, DEFAULT_STANCE} from "@/lib/v3/avatar-catalog";
import {
  derivePowerView, EXPRESSION_LABELS, normalizeStatus,
  type AlexiosStatus, type ExpressionId, type PowerAction, type CharacterVisual,
} from "@/lib/alexios";

const API_STATUS = "/api/v2/alexios/status";
const API_AUTHORIZE = "/api/v2/alexios/authorize";
const API_LOGOUT = "/api/v2/alexios/logout";
const API_POWER = "/api/v2/alexios/power";
const SCALE_BASE_WIDTH = 1600;
const SCALE_BASE_HEIGHT = 900;

const FLOOR_REASONS: Record<string, string> = {
  new_speech: "Nova fala detectada; resposta anterior cancelada.",
  microphone_stopped: "Microfone desligado antes da decisão da IA.",
  capture_disabled: "Captura desativada pelo controle FIM.",
  run_replaced: "Execução do Python substituída antes da resposta.",
  expired: "O espaço de fala expirou antes da análise.",
  invalid_timestamp: "Horário do evento inválido.",
  revoked_during_inference: "Resposta cancelada durante a inferência.",
};

function floorSummary(status: AlexiosStatus): string {
  const convo = status.conversation;
  if (!convo) return "Aguardando a primeira fala.";
  const last = convo.lastFloor;
  if (last?.fastStatus === "published") {
    return "Resposta rápida publicada" +
      (last.fastModelMs !== null && last.fastModelMs !== undefined
        ? ` · modelo ${last.fastModelMs} ms` : "") + ".";
  }
  if (last?.fastStatus === "running") return "Gerando resposta rápida...";
  if (last?.fastStatus === "pending") return "Preparando resposta rápida...";
  if (last?.fastStatus === "silent") {
    if (last.fastError) return "Modelo rápido indisponível (" + last.fastError + ").";
    if (last.fastMemoryApplied === false) {
      return "Silêncio; memória anterior preservada por atualização concorrente.";
    }
    if (last.fastMemoryApplied === true) {
      return "Silêncio escolhido; memória de contexto atualizada.";
    }
    return "Modelo rápido optou pelo silêncio.";
  }
  if (last?.fastStatus === "revoked" || last?.fastStatus === "timed_out") {
    return "Resposta rápida cancelada ou fora do prazo.";
  }
  if (last?.fastStatus === "legacy" && last.fastError && last.status !== "processed") {
    return "Falha na resposta rápida (" + last.fastError + "); recuperando pela fila.";
  }
  if (last?.fastStatus === "legacy" && last.fastError && last.status === "processed") {
    const speechAt = status.core.speech.at ? Date.parse(status.core.speech.at) : NaN;
    const floorAt = last.receivedAt ? Date.parse(last.receivedAt) : NaN;
    return Number.isFinite(speechAt) && Number.isFinite(floorAt) && speechAt >= floorAt
      ? "Resposta recuperada pela fila após falha rápida."
      : "Fast indisponível; fila processada sem resposta publicada.";
  }

  if (convo.pendingCount > 0) {
    return `Analisando ${convo.pendingCount} evento(s); último processado #${convo.processedSequence}.`;
  }
  if (!last || (convo.lastTurn && convo.lastTurn.sequence > last.sequence)) {
    return "Fala registrada. Aguardando uma oportunidade de resposta.";
  }
  if (last.status === "obsolete") {
    return FLOOR_REASONS[last.reason || ""] ||
      "Oportunidade descartada: atividade, captura ou execução alterada.";
  }
  if (last.status === "processed") {
    const speechAt = status.core.speech.at ? Date.parse(status.core.speech.at) : NaN;
    const floorAt = last.receivedAt ? Date.parse(last.receivedAt) : NaN;
    return Number.isFinite(speechAt) && Number.isFinite(floorAt) && speechAt >= floorAt
      ? "Resposta publicada no canal da personagem."
      : "Espaço avaliado; a IA permaneceu em silêncio.";
  }
  return "Aguardando processamento do espaço de fala.";
}


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

function Character({
  expression, connected, visual,
}: { expression: ExpressionId; connected: boolean; visual?: CharacterVisual }) {
  const form = avatarForm(visual?.form);
  const fallback = avatarPath(form, DEFAULT_STANCE[form], "waiting_1");
  const source = visual?.src ?? fallback;
  return (
    <div className={"character-slot " + (connected ? "is-connected" : "is-disconnected")}>
      {/* V3 images: forms, contextual stances and four operational frames. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={source}
        className="character-img"
        src={source}
        alt={"Alexios em postura " + EXPRESSION_LABELS[expression].toLowerCase()}
        draggable={false}
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.src.endsWith(fallback)) image.src = fallback;
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
  const {
    voiceEnabled, playbackState, isPlaying, voiceError, toggleVoice, stopPlayback,
  } = useAlexiosVoice(snapshot, authorized);

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
    let nextDelay = 3_500;
    let timer: number | undefined;

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
          // Fast feedback only for a running V3 session; avoid continuous
          // high-frequency DB queries when offline or on V2.
          nextDelay = freshStatus.core.protocolVersion === 3 &&
            freshStatus.core.power === "running" ? 650 : 3_500;
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

    const cycle = async () => {
      await poll();
      if (mounted) timer = window.setTimeout(() => void cycle(), nextDelay);
    };
    void cycle();
    return () => {
      mounted = false;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authorized]);

  const powerView = derivePowerView(snapshot);
  const live = powerView !== "offline";
  const { expression, visual: avatarVisual } = playbackAvatar(
    snapshot?.core.expressionId ?? "idle",
    snapshot?.core.character,
    voiceEnabled && snapshot?.core.protocolVersion === 3,
    isPlaying,
  );
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
    stopPlayback();
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
  }, [stopPlayback]);

  const sendPower = useCallback(async () => {
    if (!authorized || pending || (powerView !== "running" && powerView !== "stopped")) return;
    const action: PowerAction = powerView === "running" ? "stop" : "start";
    if (action === "stop") stopPlayback();
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
  }, [authorized, pending, powerView, stopPlayback]);

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
      <div className="console-stage console-stage--refined" style={stageStyle}>
        <div className="stage-noise" aria-hidden="true" />
        <div className="stage-graticule" aria-hidden="true" />

        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span>A</span><i /></div>
            <div className="brand-copy">
              <span className="brand-name">ALEXIOS<span className="brand-stop">.</span></span>
              <span className="brand-caption">INTELLIGENCE INTERFACE / 03</span>
            </div>
          </div>
          <div className="header-spacer" />
          <div className={"header-connection " + (apiAvailable ? "connected" : "")} role="status">
            <span className="small-led" aria-hidden="true" />
            <span>{statusText}</span>
          </div>
          <button className="access-button" onClick={() => setLoginOpen(true)} type="button">
            <LockKeyhole size={20} strokeWidth={1.8} aria-hidden="true" />
            <span>{authorized ? "GERENCIAR ACESSO" : "AUTORIZAR ACESSO"}</span>
            <ArrowUpRight size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="hud-horizon" aria-hidden="true">
          <span>INTELLIGENCE CORE</span><i /><span>OPERATIONAL INTERFACE</span>
        </div>

        <section className="hero-panel" aria-label="Personagem Alexios">
          <div className="hero-backtitle" aria-hidden="true">ALEXIOS</div>
          <div className="hero-orbit orbit-external" aria-hidden="true" />
          <div className="hero-orbit orbit-internal" aria-hidden="true" />
          <div className="orbit-ticks" aria-hidden="true" />
          <div className="figure-glow" aria-hidden="true" />
          <Character expression={expression} connected={live} visual={avatarVisual} />
          <div className="figure-floor" aria-hidden="true" />
          <div className="hero-label">
            <i className={live ? "is-live" : ""} />
            <span>{EXPRESSION_LABELS[expression]}</span>
          </div>
        </section>

        <section className="power-dock" aria-label="Controle principal de energia">
          <div className="power-rule">CONTROLE PRINCIPAL</div>
          <div className="power-control">
            <div className={"power-outer power-" + (pending ? "transitioning" : powerView)}>
              <button
                type="button"
                className="power-button"
                onClick={() => void sendPower()}
                disabled={!!pending || (powerView !== "running" && powerView !== "stopped")}
                aria-label={powerView === "running" ? "Desligar Alexios Core" :
                  powerView === "stopped" ? "Ligar Alexios Core" : "Controle de energia indisponível"}
              >
                <Power size={31} strokeWidth={1.8} aria-hidden="true" />
                <span>{powerLabel}</span>
              </button>
            </div>
            <span className="power-help" role="status">
              <span className={"help-light " + (live ? "active" : "")} aria-hidden="true" />
              {pending ? "AGUARDANDO CONFIRMAÇÃO DO AGENTE" :
                live ? "CONTROLE REMOTO DISPONÍVEL" : "AGENTE DESCONECTADO"}
            </span>
          </div>
        </section>

        <aside className="system-monitor" aria-label="Resumo da conexão e do núcleo">
          <div className="monitor-heading">
            <span>TELEMETRIA</span>
            <span className="monitor-heading-serial">/ 01</span>
          </div>
          <div className="monitor-readout">
            <div className="monitor-readout-label"><Radio size={15} /> CONEXÃO</div>
            <strong className={live ? "monitor-good" : "monitor-muted"}>
              {live ? "AGENTE ONLINE" : "AGENTE OFFLINE"}
            </strong>
          </div>
          <div className="monitor-readout">
            <div className="monitor-readout-label"><Cpu size={15} /> NÚCLEO</div>
            <strong className={powerView === "running" ? "monitor-warm" : "monitor-muted"}>
              {labels.text}
            </strong>
          </div>
          <details className="monitor-details">
            <summary>DETALHES DA CONEXÃO <ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="monitor-details-body">
              <div className="monitor-detail-row"><span><ShieldCheck size={13} /> SERVIÇO API</span><strong>{apiAvailable ? "ONLINE" : "INDISPONÍVEL"}</strong></div>
              <div className="monitor-detail-row"><span><Activity size={13} /> LONG POLLING</span><strong>{live ? "ATIVO" : "INATIVO"}</strong></div>
              <div className="monitor-detail-row"><span><CircleDot size={13} /> ÚLTIMO CONTATO</span><strong>{formatPoll(snapshot?.agent.lastPollAt ?? null)}</strong></div>
              <div className="monitor-detail-row"><span>CORE POWER</span><strong>{snapshot?.core.power.toUpperCase() ?? "UNKNOWN"}</strong></div>
              <div className="monitor-detail-row"><span>VERSÃO</span><strong>V{snapshot?.core.protocolVersion ?? "—"}</strong></div>
              {snapshot?.core.protocolVersion === 3 && (
                <div className="monitor-conversation">
                  <span className="monitor-subtitle"><Headphones size={13} /> ÚLTIMA FALA RECEBIDA</span>
                  <p>{snapshot.conversation?.lastTurn?.text || "Nenhuma transcrição recebida."}</p>
                  <span className="monitor-metadata">
                    {snapshot.conversation?.lastTurn
                      ? `#${snapshot.conversation.lastTurn.sequence} · ${snapshot.conversation.lastTurn.speakerId} · ${snapshot.conversation.lastTurn.status}`
                      : "AGUARDANDO"}
                  </span>
                  <span className="monitor-subtitle monitor-subtitle--spaced">PROCESSAMENTO</span>
                  <p>{floorSummary(snapshot)}</p>
                  <span className="monitor-metadata">
                    EVENTOS {snapshot.conversation?.processedSequence ?? 0} / {snapshot.conversation?.acceptedSequence ?? 0}
                  </span>
                </div>
              )}
              {snapshot?.core.lastError && <p className="monitor-error" role="alert">{snapshot.core.lastError}</p>}
            </div>
          </details>
        </aside>

        <section
          className={`response-focus ${isPlaying ? "response-focus--speaking" : ""}`}
          aria-label="Última resposta do Alexios"
        >
          <div className="response-focus-header">
            <div className="response-focus-identity">
              <span className="response-focus-indicator" aria-hidden="true" />
              <span>RESPOSTA DO ALEXIOS</span>
              {playbackState === "generating" && (
                <span className="response-voice-status">PREPARANDO ÁUDIO</span>
              )}
              {playbackState === "playing" && (
                <span className="response-voice-status">REPRODUZINDO</span>
              )}
            </div>
            {snapshot?.core.protocolVersion === 3 && (
              <button
                type="button"
                className="speech-voice-toggle response-voice-button"
                onClick={() => void toggleVoice()}
                aria-pressed={voiceEnabled}
                title="Ativar ou desativar a voz"
              >
                <Volume2 size={15} aria-hidden="true" />
                <span>{voiceEnabled ? "VOZ ATIVA" : "ATIVAR VOZ"}</span>
              </button>
            )}
          </div>
          <div className="response-focus-content">
            <p className={snapshot?.core.speech.text
              ? "response-focus-text"
              : "response-focus-text response-focus-text--empty"}
              aria-live="polite"
              aria-atomic="true"
            >
              {snapshot?.core.speech.text ||
                "Aguardando a próxima resposta. O Alexios também pode escolher permanecer em silêncio."}
            </p>
          </div>
          {voiceError && <p className="tts-feedback" role="status">{voiceError}</p>}
          <div className="response-focus-footer">
            <span>{snapshot?.core.speech.at
              ? `RESPONDIDO ÀS ${formatPoll(snapshot.core.speech.at)}`
              : "AGUARDANDO RESPOSTA"}
            </span>
            <span className="response-focus-footer-id">ALEXIOS // SYSTEM 01</span>
          </div>
        </section>

        {(commandError || connectionError) && (
          <div className="console-error" role="alert">
            <WifiOff size={16} aria-hidden="true" /> {commandError || connectionError}
          </div>
        )}

        <footer className="footerbar">
          <span>ALEXIOS / INTELLIGENCE CONTROL</span>
          <span>INTERFACE V{snapshot?.core.protocolVersion ?? "—"}</span>
        </footer>

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
