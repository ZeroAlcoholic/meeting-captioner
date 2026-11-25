import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthEvent, HealthState } from '@meeting-audio/contracts';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';
import {
  GeminiLiveProvider,
  prewarmGeminiSession,
  cancelGeminiPrewarm,
} from './gemini-live-provider.js';
import { startSessionInfoPolling } from './session-info-polling.js';
import { leaseCapture } from './capture-lease.js';
import { createStoreBoundHandlers, type CoalescingHandlersOptions } from './coalesce-handlers.js';
import { translationReadiness } from './translation-readiness.js';
import type { AudioSource, ProviderStatus, TranslationTrackScope } from './types.js';

const TOKEN_URL = `${ONLINE_SERVICE_URL}/session/gemini`;
const INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

/** 'checking' | 'available' | 'no-key' | 'service-down' */
export type GeminiStatus = 'checking' | 'available' | 'no-key' | 'service-down';

export interface UseGeminiLive {
  status: ProviderStatus;
  error: string | null;
  geminiStatus: GeminiStatus;
  available: boolean;
  start: (options?: {
    awaitContent?: boolean;
    archive?: CoalescingHandlersOptions['archive'];
  }) => Promise<boolean>;
  stop: (options?: { preserveHealth?: boolean }) => void;
  restoreHealth: () => void;
  /**
   * Mint a token while this backend is the STANDBY, so a failover onto it does
   * not begin with a network round-trip. The caller drives the schedule: only it
   * knows what is running, and warm tokens expire.
   */
  prewarmStandby: (refreshIfOlderThanMs?: number) => void;
  /**
   * This backend's own transport health, read at call time. A failover that
   * awaited the standby needs to know whether THIS backend reconnected in the
   * meantime; the shared health slot carries whichever provider wrote last.
   */
  getTransport: () => HealthState;
}

export interface UseOnlineProviderOptions {
  disablePolling?: boolean;
  disableAutoPrewarm?: boolean;
  retainAudio?: boolean;
}

export function useGeminiLive(
  track?: TranslationTrackScope,
  options?: UseOnlineProviderOptions,
): UseGeminiLive {
  const trackRef = useRef(track);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const providerRef = useRef<GeminiLiveProvider | null>(null);
  const healthRef = useRef(new Map<HealthEvent['component'], HealthEvent>());
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // This backend's own transport health, kept in a ref so a failover that
  // awaited a standby bring-up reads the state as it is then, not as it was
  // when the callback closed over it — the same-vendor-wins decision has to
  // be made on a current value.
  const transportRef = useRef<HealthState>('idle');
  const errorComponentRef = useRef<string | null>(null);
  const acceptingHealthRef = useRef(false);
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus>('checking');
  const modeId = useSettingsStore((s) => s.modeId);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);

  // Poll /session/info to learn whether the server has a GEMINI_API_KEY.
  useEffect(() => {
    const stopPolling = optionsRef.current?.disablePolling
      ? () => {}
      : startSessionInfoPolling(
          INFO_URL,
          (info) => {
            const ok = info.hasGeminiKey ?? info.availableProviders?.includes('gemini') ?? false;
            setGeminiStatus(ok ? 'available' : 'no-key');
          },
          () => setGeminiStatus('service-down'),
        );
    return () => {
      stopPolling();
      acceptingHealthRef.current = false;
      const provider = providerRef.current;
      providerRef.current = null;
      provider?.stop();
      handlersRef.current?.finish();
      handlersRef.current = null;
      if (!trackRef.current) cancelGeminiPrewarm();
    };
  }, []);

  // Pre-mint the Gemini token while idle so Start skips the mint RTT (single-use,
  // fresh-guarded; reconnects mint fresh). Hard-gated by selected online
  // mode/backend so Full Offline never mints a cloud token while idle.
  useEffect(() => {
    if (trackRef.current || optionsRef.current?.disableAutoPrewarm) return;
    if (modeId !== 'online_full') {
      if (!trackRef.current) cancelGeminiPrewarm();
      return;
    }
    if (onlineProvider !== 'gemini') return;
    if (geminiStatus !== 'available' || status !== 'idle') return;
    prewarmGeminiSession(TOKEN_URL);
    return () => {
      const settings = settingsStore.getState();
      // Starting may still be waiting for permission before consuming this token.
      if (settings.modeId !== 'online_full' || settings.onlineProvider !== 'gemini') {
        if (!trackRef.current) cancelGeminiPrewarm();
      }
    };
  }, [geminiStatus, modeId, onlineProvider, status]);

  // Same mint, for when this backend is the STANDBY rather than the selection —
  // the other model is live and this one has to be ready to take over without a
  // token round-trip. The caller owns the schedule because only it knows what is
  // running; warm tokens expire, so a one-shot mint at session start would be
  // stale long before the failure it exists for.
  const prewarmStandby = useCallback(
    (refreshIfOlderThanMs?: number) => {
      if (trackRef.current || geminiStatus !== 'available') return;
      prewarmGeminiSession(TOKEN_URL, refreshIfOlderThanMs);
    },
    [geminiStatus],
  );

  const start = useCallback(
    async (options?: {
      awaitContent?: boolean;
      archive?: CoalescingHandlersOptions['archive'];
    }): Promise<boolean> => {
      setError(null);
      errorComponentRef.current = null;
      const previous = providerRef.current;
      if (previous) {
        // Unconditionally, including when it already reads as stopped. A stopped
        // provider can still be draining its tail on an open socket, and each
        // start builds a NEW instance — so skipping this would leave the old
        // socket alive to deliver the previous meeting's last words into the new
        // one, after beginSession() has cleared the board. stop() is idempotent.
        previous.stop();
        handlersRef.current?.finish();
      }

      const { langPair, micDistance, audioSource } = settingsStore.getState();
      const scope = trackRef.current;
      const handlers = createStoreBoundHandlers({
        ...(options?.archive ? { archive: options.archive } : {}),
        ...(scope
          ? { trackId: scope.trackId, onHealth: scope.onHealth, onAudioLevel: scope.onAudioLevel }
          : {}),
      });
      const readiness = translationReadiness(options?.awaitContent === true);
      healthRef.current.clear();
      // Surface fatal health events (mic denied, token mint failure, transport
      // failure) to the React error banner — mirrors the OpenAI hook.
      const origOnHealth = handlers.onHealth;
      handlers.onHealth = (ev) => {
        if (!acceptingHealthRef.current || providerRef.current !== provider) return;
        ev = readiness.health(ev);
        if (ev.component === 'transport') transportRef.current = ev.state;
        const failed =
          ev.state === 'failed' || ev.state === 'api_error' || ev.state === 'no_audio_track';
        if (failed && ev.component === 'audio') {
          // An ended source cannot heal by rotating cloud sessions. Stop its
          // transport and keep the source failure visible until the user retries.
          provider.stop();
          setStatus('idle');
        }
        // stop() can synchronously emit stopped; cache the final published event.
        healthRef.current.set(ev.component, ev);
        origOnHealth(ev);
        if (failed && ev.message) {
          errorComponentRef.current = ev.component;
          setError(ev.message);
        } else if (ev.state === 'connected' && errorComponentRef.current === ev.component) {
          errorComponentRef.current = null;
          setError(null);
        }
      };
      // Keep graceful Stop tails, but never let a replaced/unmounted owner write.
      const onTranscript = handlers.onTranscript;
      const onTranslation = handlers.onTranslation;
      const onAudioLevel = handlers.onAudioLevel;
      handlers.onTranscript = (event) => {
        if (providerRef.current !== provider) return;
        onTranscript(event);
        const restored = readiness.content(event.text);
        if (restored) handlers.onHealth(restored);
      };
      handlers.onTranslation = (event) => {
        if (providerRef.current !== provider) return;
        onTranslation(event);
        const restored = readiness.content(event.targetText);
        if (restored) handlers.onHealth(restored);
      };
      handlers.onAudioLevel = (event) => {
        if (providerRef.current === provider) onAudioLevel(event);
      };
      handlersRef.current = handlers;
      // Honour the user's audio-source selection, mirroring the OpenAI hook:
      // 'system' captures Teams/Zoom via getDisplayMedia (mic DSP profile is
      // irrelevant there — the signal is pre-mixed), 'mic' uses getUserMedia
      // with the selected acoustic profile. Without this branch the 🔊 chip
      // would claim system capture while Gemini silently recorded the mic.
      const isSystemAudio = scope ? scope.trackId === 'remote' : audioSource === 'system';
      const effectiveMicDistance: 'meeting' | 'close' | 'far' | 'off' = isSystemAudio
        ? 'off'
        : micDistance;
      // Leased, not constructed: a failover handoff reuses the capture that is
      // already running instead of re-opening the device mid-meeting.
      const audio: AudioSource =
        scope?.createAudio() ??
        leaseCapture({
          kind: isSystemAudio ? 'system' : 'mic',
          micDistance: effectiveMicDistance,
          deviceId: settingsStore.getState().micDeviceId,
          ...(optionsRef.current?.retainAudio !== undefined
            ? { retainAudio: optionsRef.current.retainAudio }
            : {}),
        });
      const provider = new GeminiLiveProvider(
        TOKEN_URL,
        handlers,
        audio,
        langPair,
        effectiveMicDistance,
        // Stamp what was really captured. Events used to claim 'microphone' even
        // when the audio came from a shared screen, which quietly made the 🔊
        // system-capture chip and the event log disagree about the same session.
        isSystemAudio ? 'browser_system' : 'microphone',
      );
      providerRef.current = provider;
      acceptingHealthRef.current = true;
      setStatus('running');

      try {
        await provider.start();
        if (!acceptingHealthRef.current || providerRef.current !== provider) return false;
        if (provider.status === 'stopped') {
          setStatus('idle');
          return false;
        }
        return true;
      } catch (err) {
        if (!acceptingHealthRef.current || providerRef.current !== provider) return false;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('idle');
        return false;
      }
    },
    [],
  );

  const stop = useCallback((options?: { preserveHealth?: boolean }) => {
    const provider = providerRef.current;
    if (!trackRef.current) cancelGeminiPrewarm();
    if (options?.preserveHealth) acceptingHealthRef.current = false;
    provider?.stop();
    handlersRef.current?.finish();
    acceptingHealthRef.current = false;
    transportRef.current = 'stopped';
    errorComponentRef.current = null;
    setError(null);
    setStatus('stopped');
    return provider?.waitForStop() ?? Promise.resolve();
  }, []);

  return {
    status,
    error,
    geminiStatus,
    available: geminiStatus === 'available',
    start,
    stop,
    prewarmStandby,
    getTransport: () => transportRef.current,
    restoreHealth: () => {
      if (acceptingHealthRef.current)
        for (const event of healthRef.current.values())
          (trackRef.current?.onHealth ?? settingsStore.getState().applyHealth)(event);
    },
  };
}
