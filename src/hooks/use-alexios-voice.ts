"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AlexiosStatus } from "@/lib/alexios";
import { CARTESIA_SAMPLE_RATE } from "@/lib/tts/key-manager";
import { PcmF32Chunker } from "@/lib/tts/pcm";
import { shouldInterruptForConfirmedTurn } from "@/lib/tts/interruption-policy";

export type VoicePlaybackState = "idle" | "generating" | "playing";

type ActivePlayback = {
  controller: AbortController;
  sources: Set<AudioBufferSourceNode>;
  streamComplete: boolean;
  speechSeq: number;
  playbackId: string;
  leaseStarted: Promise<void> | null;
  heartbeat: number | null;
  speechText: string;
  speechAtMs: number;
  lastTurnSequenceAtStart: number;
};

/**
 * One user-activated Web Audio output, no replay of existing speech_seq.
 * Speaking is held until the last scheduled audio source *actually ends*.
 */
export function useAlexiosVoice(snapshot: AlexiosStatus | null, authorized: boolean | null) {
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [playbackState, setPlaybackState] = useState<VoicePlaybackState>("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const activeRef = useRef<ActivePlayback | null>(null);
  const lastSeenSpeech = useRef<number | null>(null);

  const playbackUpdate = useCallback(async (
    action: "start" | "pulse" | "finish", active: ActivePlayback,
  ) => {
    const response = await fetch("/api/v2/alexios/playback", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      keepalive: action === "finish",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        action, playbackId: active.playbackId, speechSeq: active.speechSeq,
      }),
    });
    if (!response.ok) throw new Error("Não foi possível sincronizar a escuta com o áudio.");
  }, []);

  const closePlaybackLease = useCallback((active: ActivePlayback) => {
    if (active.heartbeat !== null) {
      window.clearInterval(active.heartbeat);
      active.heartbeat = null;
    }
    if (active.leaseStarted) {
      // Finish MUST be sent after start, even if it is still in flight.
      void active.leaseStarted.then(() =>
        playbackUpdate("finish", active),
      ).catch(() => {});
    }
  }, [playbackUpdate]);

  // Imperative cancellation is deliberately independent of React state:
  // snapshot effects only synchronize external audio resources.
  const cancelAudioResources = useCallback(() => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active) {
      closePlaybackLease(active);
      active.controller.abort();
      for (const source of active.sources) {
        source.onended = null;
        try { source.stop(); } catch { /* already ended */ }
        source.disconnect();
      }
      active.sources.clear();
    }
  }, [closePlaybackLease]);

  const stopPlayback = useCallback((updateUI = true) => {
    cancelAudioResources();
    if (updateUI) setPlaybackState("idle");
  }, [cancelAudioResources]);

  const stopForSnapshot = useCallback(() => {
    if (!activeRef.current) return;
    cancelAudioResources();
    // React state is updated outside the synchronous effect phase. Do not
    // override a newer playback that might start during this same turn.
    queueMicrotask(() => {
      if (!activeRef.current) setPlaybackState("idle");
    });
  }, [cancelAudioResources]);

  const playSpeech = useCallback(async (
    sequence: number,
    activityEpoch: number,
    speechText: string,
    speechAtMs: number,
    lastTurnSequenceAtStart: number,
  ) => {
    const context = contextRef.current;
    if (!context || context.state === "closed") return;
    stopPlayback();
    const active: ActivePlayback = {
      controller: new AbortController(),
      sources: new Set(),
      streamComplete: false,
      speechSeq: sequence,
      playbackId: crypto.randomUUID(),
      leaseStarted: null,
      heartbeat: null,
      speechText,
      speechAtMs,
      lastTurnSequenceAtStart,
    };
    activeRef.current = active;
    setPlaybackState("generating");
    setVoiceError(null);
    const isCurrent = () => activeRef.current === active && !active.controller.signal.aborted;
    try {
      if (context.state !== "running") await context.resume();
      if (!isCurrent()) return;
      const response = await fetch("/api/v2/alexios/tts", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence, activityEpoch }),
        signal: active.controller.signal,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error).slice(0, 180)
          : "Não foi possível sintetizar a resposta.";
        throw new Error(detail);
      }
      if (!response.body) throw new Error("Streaming de áudio indisponível.");
      const reader = response.body.getReader();
      const pcm = new PcmF32Chunker();
      let nextStart = context.currentTime + 0.02;
      let hasAudio = false;

      const schedule = async (samples: Float32Array) => {
        if (!isCurrent() || !samples.length) return;
        if (!active.leaseStarted) {
          // Confirm the server has stopped listening before sound is audible.
          active.leaseStarted = playbackUpdate("start", active);
          await active.leaseStarted;
          if (!isCurrent()) return;
          active.heartbeat = window.setInterval(() => {
            void playbackUpdate("pulse", active).catch(() => {
              if (isCurrent()) {
                stopPlayback();
                setVoiceError("Escuta não foi pausada no servidor; áudio interrompido.");
              }
            });
          }, 2_000);
        }
        if (!isCurrent()) return;
        const buffer = context.createBuffer(1, samples.length, CARTESIA_SAMPLE_RATE);
        buffer.getChannelData(0).set(samples);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const startTime = Math.max(nextStart, context.currentTime + 0.02);
        nextStart = startTime + buffer.duration;
        source.onended = () => {
          active.sources.delete(source);
          source.disconnect();
          if (isCurrent() && active.streamComplete && active.sources.size === 0) {
            closePlaybackLease(active);
            activeRef.current = null;
            setPlaybackState("idle");
          }
        };
        active.sources.add(source);
        source.start(startTime);
        if (!hasAudio) {
          hasAudio = true;
          setPlaybackState("playing");
        }
      };

      while (isCurrent()) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isCurrent()) break;
        for (const samples of pcm.push(value)) await schedule(samples);
      }
      if (!isCurrent()) {
        await reader.cancel().catch(() => {});
        return;
      }
      const tail = pcm.flush();
      if (tail) await schedule(tail);
      if (!hasAudio) throw new Error("A Cartesia não retornou áudio.");
      active.streamComplete = true;
      if (active.sources.size === 0 && isCurrent()) {
        closePlaybackLease(active);
        activeRef.current = null;
        setPlaybackState("idle");
      }
    } catch (error) {
      if (!isCurrent()) return; // canceled by new speech, FIM, logout or voice toggle
      const message = error instanceof Error ? error.message : "Falha ao reproduzir a voz.";
      stopPlayback();
      setVoiceError(message);
    }
  }, [stopPlayback, playbackUpdate, closePlaybackLease]);

  useEffect(() => {
    if (authorized !== true) {
      stopForSnapshot();
      lastSeenSpeech.current = null;
      return;
    }
    if (!snapshot) {
      stopForSnapshot();
      return;
    }
    const seq = snapshot.core.speech.seq;
    const epoch = snapshot.conversation?.activityEpoch ?? null;
    if (lastSeenSpeech.current === null || seq < lastSeenSpeech.current) {
      lastSeenSpeech.current = seq;
      return; // never speak the last response after login or refresh
    }

    if (activeRef.current) {
      if (snapshot.core.power !== "running" || !snapshot.agent.connected ||
          !voiceEnabled ||
          shouldInterruptForConfirmedTurn(
            activeRef.current, snapshot.conversation?.lastTurn ?? null,
          )) {
        stopForSnapshot();
      }
      // Do NOT abort just because activityEpoch increased: the agent microphone
      // can hear the assistant's own voice and produce VAD speech_started.
    }
    if (seq <= lastSeenSpeech.current) return;
    lastSeenSpeech.current = seq;
    const timestamp = snapshot.core.speech.at ? Date.parse(snapshot.core.speech.at) : NaN;
    if (!voiceEnabled || snapshot.core.protocolVersion !== 3 || !snapshot.agent.connected ||
        snapshot.core.power !== "running" || !snapshot.core.speech.text.trim() ||
        epoch === null || !Number.isFinite(timestamp) ||
        timestamp > Date.now() + 5_000 || Date.now() - timestamp > 5_000) return;
    // Start the network operation after the synchronous React effect phase.
    const baselineTurn = snapshot.conversation?.lastTurn?.sequence ?? 0;
    const speechText = snapshot.core.speech.text;
    queueMicrotask(() => {
      void playSpeech(seq, epoch, speechText, timestamp, baselineTurn);
    });
  }, [snapshot, authorized, voiceEnabled, stopForSnapshot, playSpeech]);

  const toggleVoice = useCallback(async () => {
    if (voiceEnabled) {
      setVoiceEnabled(false);
      stopPlayback();
      return;
    }
    if (typeof window === "undefined" || !("AudioContext" in window)) {
      setVoiceError("Este navegador não suporta reprodução de áudio em tempo real.");
      return;
    }
    try {
      const context = contextRef.current ?? new AudioContext({ sampleRate: CARTESIA_SAMPLE_RATE });
      contextRef.current = context;
      await context.resume(); // must be triggered by explicit user interaction
      setVoiceError(null);
      setVoiceEnabled(true);
    } catch {
      setVoiceError("O navegador bloqueou a reprodução. Ative a voz novamente.");
    }
  }, [voiceEnabled, stopPlayback]);

  useEffect(() => {
    return () => {
      stopPlayback(false);
      if (contextRef.current) void contextRef.current.close().catch(() => {});
      contextRef.current = null;
    };
  }, [stopPlayback]);

  return {
    voiceEnabled,
    playbackState,
    isPlaying: playbackState === "playing",
    voiceError,
    toggleVoice,
    stopPlayback,
  };
}
