import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';
import { GeminiLiveProvider, prewarmGeminiSession } from './gemini-live-provider.js';
import { leaseCapture } from './capture-lease.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { AudioSource, ProviderStatus } from './types.js';

const TOKEN_URL = `${ONLINE_SERVICE_URL}/session/gemini`;
const INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;

/** 'checking' | 'available' | 'no-key' | 'service-down' */
export type GeminiStatus = 'checking' | 'available' | 'no-key' | 'service-down';

export interface UseGeminiLive {
  status: ProviderStatus;
  error: string | null;
  geminiStatus: GeminiStatus;
  available: boolean;
  start: () => Promise<boolean>;
  stop: () => void;
}

export function useGeminiLive(): UseGeminiLive {
  const providerRef = useRef<GeminiLiveProvider | null>(null);
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus>('checking');
  const modeId = useSettingsStore((s) => s.modeId);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);

  // Poll /session/info to learn whether the server has a GEMINI_API_KEY.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      timer = setTimeout(poll, delay);
    };
    const poll = (): void => {
      fetch(INFO_URL)
        .then((r) => r.json())
        .then((d: { availableProviders?: string[]; hasGeminiKey?: boolean }) => {
          if (cancelled) return;
          const ok = d.hasGeminiKey ?? d.availableProviders?.includes('gemini') ?? false;
          setGeminiStatus(ok ? 'available' : 'no-key');
          schedule(POLL_SLOW_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setGeminiStatus('service-down');
          schedule(POLL_FAST_MS);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      providerRef.current?.stop();
    };
  }, []);

  // Pre-mint the Gemini token while idle so Start skips the mint RTT (single-use,
  // fresh-guarded; reconnects mint fresh). Hard-gated by selected online
  // mode/backend so Full Offline never mints a cloud token while idle.
  useEffect(() => {
    if (modeId !== 'online_full' || onlineProvider !== 'gemini') return;
    if (geminiStatus !== 'available' || status === 'running') return;
    prewarmGeminiSession(TOKEN_URL);
  }, [geminiStatus, modeId, onlineProvider, status]);

  // Same mint, for when this backend is the STANDBY rather than the selection —
  // the other model is live and this one has to be ready to take over without a
  // token round-trip. The caller owns the schedule because only it knows what is
  // running; warm tokens expire, so a one-shot mint at session start would be
  // stale long before the failure it exists for.
  const prewarmStandby = useCallback(() => {
    if (geminiStatus !== 'available') return;
    prewarmGeminiSession(TOKEN_URL);
  }, [geminiStatus]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    const previous = providerRef.current;
    if (previous && previous.status !== 'stopped') {
      previous.stop();
      handlersRef.current?.flushPending();
    }

    const { langPair, micDistance, audioSource } = settingsStore.getState();
    const handlers = createStoreBoundHandlers();
    // Surface fatal health events (mic denied, token mint failure, transport
    // failure) to the React error banner — mirrors the OpenAI hook.
    const origOnHealth = handlers.onHealth;
    handlers.onHealth = (ev) => {
      origOnHealth(ev);
      if (
        (ev.state === 'failed' || ev.state === 'api_error' || ev.state === 'no_audio_track') &&
        ev.message
      ) {
        setError(ev.message);
      }
    };
    handlersRef.current = handlers;
    // Honour the user's audio-source selection, mirroring the OpenAI hook:
    // 'system' captures Teams/Zoom via getDisplayMedia (mic DSP profile is
    // irrelevant there — the signal is pre-mixed), 'mic' uses getUserMedia
    // with the selected acoustic profile. Without this branch the 🔊 chip
    // would claim system capture while Gemini silently recorded the mic.
    const effectiveMicDistance: 'meeting' | 'close' | 'far' | 'off' =
      audioSource === 'system' ? 'off' : micDistance;
    // Leased, not constructed: a failover handoff reuses the capture that is
    // already running instead of re-opening the device mid-meeting.
    const audio: AudioSource = leaseCapture({
      kind: audioSource === 'system' ? 'system' : 'mic',
      micDistance: effectiveMicDistance,
    });
    const provider = new GeminiLiveProvider(
      TOKEN_URL,
      handlers,
      audio,
      langPair,
      effectiveMicDistance,
    );
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      if (providerRef.current !== provider) return false;
      if (provider.status === 'stopped') {
        setStatus('idle');
        return false;
      }
      return true;
    } catch (err) {
      if (providerRef.current !== provider) return false;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
      return false;
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    handlersRef.current?.flushPending();
    setStatus('stopped');
  }, []);

  return {
    status,
    error,
    geminiStatus,
    available: geminiStatus === 'available',
    start,
    stop,
    prewarmStandby,
  };
}
