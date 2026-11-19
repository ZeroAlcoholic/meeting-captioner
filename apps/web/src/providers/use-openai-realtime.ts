import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthEvent, HealthState } from '@meeting-audio/contracts';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';
import {
  OpenAIRealtimeProvider,
  cancelOpenAIPrewarm,
  prewarmOpenAISession,
  sessionRequestBody,
} from './openai-realtime-provider.js';
import { startSessionInfoPolling } from './session-info-polling.js';
import { leaseCapture } from './capture-lease.js';
import { createStoreBoundHandlers, type CoalescingHandlersOptions } from './coalesce-handlers.js';
import { translationReadiness } from './translation-readiness.js';
import type { AudioSource, ProviderStatus, TranslationTrackScope } from './types.js';

const SESSION_URL = `${ONLINE_SERVICE_URL}/session`;
const SESSION_INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

export type ApiKeyStatus = 'checking' | 'present' | 'no-key' | 'service-down';

export interface UseOpenAIRealtime {
  status: ProviderStatus;
  error: string | null;
  apiKeyStatus: ApiKeyStatus;
  /**
   * Resolves to `true` if the realtime provider reached the `running`
   * state, `false` if startup failed (mic denied, /session 5xx, SDP
   * exchange failed, etc.). Callers use this to gate side effects like
   * the session-cost timer that must not run for failed sessions.
   */
  start: (options?: {
    awaitContent?: boolean;
    archive?: CoalescingHandlersOptions['archive'];
  }) => Promise<boolean>;
  stop: (options?: { preserveHealth?: boolean }) => void;
  restoreHealth: () => void;
  retry: () => void;
  /**
   * Read the renewal ETA on demand. Returns null when no session is running.
   * Pulled from a ref so consumers can poll without forcing the hook owner to
   * re-render at 1 Hz — the previous design caused unnecessary App.tsx
   * re-renders that cascaded through the caption board's shell.
   */
  getRenewalEtaMs: () => number | null;
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

export function useOpenAIRealtime(track?: TranslationTrackScope): UseOpenAIRealtime {
  const trackRef = useRef(track);
  const providerRef = useRef<OpenAIRealtimeProvider | null>(null);
  const healthRef = useRef(new Map<HealthEvent['component'], HealthEvent>());
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  // Holds the current provider's onStatus unsubscribe so we can detach
  // before swapping providers (start-restart cycle) without leaking the
  // old subscription into the new provider's lifecycle.
  const statusUnsubRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // This backend's own transport health, kept in a ref so a failover that
  // awaited a standby bring-up reads the state as it is then, not as it was
  // when the callback closed over it — the same-vendor-wins decision has to
  // be made on a current value.
  const transportRef = useRef<HealthState>('idle');
  const errorComponentRef = useRef<string | null>(null);
  const acceptingHealthRef = useRef(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('checking');
  const modeId = useSettingsStore((s) => s.modeId);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);

  // ── /session/info polling with backoff ───────────────────────────────────────
  useEffect(() => {
    const stopPolling = startSessionInfoPolling(
      SESSION_INFO_URL,
      (info) => {
        setApiKeyStatus(info.hasApiKey ? 'present' : 'no-key');
      },
      () => setApiKeyStatus('service-down'),
    );
    return () => {
      stopPolling();
      acceptingHealthRef.current = false;
      const provider = providerRef.current;
      providerRef.current = null;
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;
      provider?.stop();
      handlersRef.current?.finish();
      handlersRef.current = null;
      if (!trackRef.current) cancelOpenAIPrewarm();
    };
  }, []);

  // ── Pre-mint the ephemeral token while idle ──────────────────────────────────
  // The token fetch is the long pole on a WARM start (shared audio context +
  // parallel mic already removed the others). Mint it ahead of the click — keyed
  // to the CURRENT settings — so Start consumes it instantly. Single-use + fresh
  // + key-matched (see WarmTokenCache); any mismatch falls back to a live fetch,
  // so the worst case is exactly today's behaviour. Hard-gated by the selected
  // online mode/backend so Full Offline never mints a cloud token while idle.
  const mintWarmToken = useCallback((refreshIfOlderThanMs?: number) => {
    const { langPair, includeSourceTranscript, micDistance, audioSource } =
      settingsStore.getState();
    // Mirror the live path's effective mic distance (system capture → 'off').
    const effective = audioSource === 'system' ? 'off' : micDistance;
    prewarmOpenAISession(
      SESSION_URL,
      sessionRequestBody(langPair, includeSourceTranscript, effective),
      refreshIfOlderThanMs,
    );
  }, []);

  useEffect(() => {
    if (trackRef.current) return;
    if (modeId !== 'online_full') {
      if (!trackRef.current) cancelOpenAIPrewarm();
      return;
    }
    if (onlineProvider !== 'openai') return;
    if (apiKeyStatus !== 'present' || status !== 'idle') return;
    mintWarmToken();
    return () => {
      const settings = settingsStore.getState();
      // Starting may still be waiting for permission before consuming this token.
      if (settings.modeId !== 'online_full' || settings.onlineProvider !== 'openai') {
        if (!trackRef.current) cancelOpenAIPrewarm();
      }
    };
  }, [apiKeyStatus, modeId, onlineProvider, status, mintWarmToken]);

  // Same mint, for when this backend is the STANDBY rather than the selection —
  // the other model is live and this one has to be ready to take over without a
  // token round-trip. The caller owns the schedule because only it knows what is
  // running; warm tokens expire, so a one-shot mint at session start would be
  // stale long before the failure it exists for.
  const prewarmStandby = useCallback(
    (refreshIfOlderThanMs?: number) => {
      if (trackRef.current || apiKeyStatus !== 'present') return;
      mintWarmToken(refreshIfOlderThanMs);
    },
    [apiKeyStatus, mintWarmToken],
  );

  const start = useCallback(
    async (options?: {
      awaitContent?: boolean;
      archive?: CoalescingHandlersOptions['archive'];
    }): Promise<boolean> => {
      setError(null);
      errorComponentRef.current = null;
      // A new start owns a new provider; cancel all work from the previous one.
      const previous = providerRef.current;
      if (previous) {
        previous.stop();
        handlersRef.current?.finish();
      }
      // Drop the previous provider's status subscription before overwriting
      // its ref — otherwise the old instance's late callbacks (timer-driven
      // retry, in-flight cleanup) would still mutate React state and step on
      // the new provider's events.
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;

      const { langPair, includeSourceTranscript, micDistance, audioSource } =
        settingsStore.getState();
      const scope = trackRef.current;
      const handlers = createStoreBoundHandlers({
        ...(options?.archive ? { archive: options.archive } : {}),
        ...(scope
          ? { trackId: scope.trackId, onHealth: scope.onHealth, onAudioLevel: scope.onAudioLevel }
          : {}),
      });
      const readiness = translationReadiness(options?.awaitContent === true);
      healthRef.current.clear();
      // Intercept health failure events so audio-layer errors (mic permission
      // denied, device disconnect) and transport errors surface in the React
      // error banner. Without this, provider.start() returns false silently
      // when the mic is denied — the user sees the Start button revert with
      // no explanation. setError(null) at the top of start() clears on retry.
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
      // Branch on the user-chosen audio source. 'system' uses getDisplayMedia
      // for browser tab / system-audio capture (Teams/Zoom in another window);
      // 'mic' uses getUserMedia for an attached microphone. The OpenAI side of
      // the audio path doesn't care which one fed it — it just consumes the
      // MediaStream — so we keep the AudioSource interface symmetric.
      //
      // For system audio, micDistance is forced to 'off' so the upstream
      // noise_reduction profile doesn't fight pre-mixed clean signal. The
      // SettingsPanel mirrors this by greying out the mic-distance buttons
      // when audioSource === 'system', so the UI and the actual /session
      // payload stay in sync.
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
        });
      const provider = new OpenAIRealtimeProvider(
        SESSION_URL,
        handlers,
        langPair,
        audio,
        includeSourceTranscript,
        effectiveMicDistance,
        // Stamp what was really captured. Events used to claim 'microphone' even
        // when the audio came from a shared screen, which quietly made the 🔊
        // system-capture chip and the event log disagree about the same session.
        isSystemAudio ? 'browser_system' : 'microphone',
      );
      providerRef.current = provider;
      acceptingHealthRef.current = true;
      // Keep startup failures reflected in the UI; renewal stays running.
      statusUnsubRef.current = provider.onStatus((s) => {
        if (providerRef.current !== provider) return; // stale callback
        // Failed startup leaves the meeting available for recovery or Retry.
        setStatus(s === 'stopped' ? 'idle' : s);
      });
      setStatus('running');

      try {
        await provider.start();
        // If a newer start() raced and replaced providerRef while we were
        // awaiting, leave the newer one's state alone.
        if (!acceptingHealthRef.current || providerRef.current !== provider) return false;
        if (provider.status === 'stopped') {
          // Internal error path (mic denied, /session non-2xx, SDP exchange
          // failed). The provider already cleaned up; surface as not-running
          // so callers don't start the cost timer.
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
    if (!trackRef.current) cancelOpenAIPrewarm();
    if (options?.preserveHealth) acceptingHealthRef.current = false;
    const provider = providerRef.current;
    provider?.stop({ drain: true });
    handlersRef.current?.finish();
    acceptingHealthRef.current = false;
    transportRef.current = 'stopped';
    errorComponentRef.current = null;
    setError(null);
    setStatus('stopped');
    return provider?.waitForStop() ?? Promise.resolve();
  }, []);

  const retry = useCallback(() => {
    void start();
  }, [start]);

  // Stable getter — consumers can read it inside their own intervals without
  // bumping renders here. Returns null when no provider or not running.
  const getRenewalEtaMs = useCallback((): number | null => {
    return providerRef.current?.getRenewalEtaMs() ?? null;
  }, []);

  return {
    status,
    error,
    apiKeyStatus,
    start,
    stop,
    retry,
    getRenewalEtaMs,
    prewarmStandby,
    getTransport: () => transportRef.current,
    restoreHealth: () => {
      if (acceptingHealthRef.current)
        for (const event of healthRef.current.values())
          (trackRef.current?.onHealth ?? settingsStore.getState().applyHealth)(event);
    },
  };
}
