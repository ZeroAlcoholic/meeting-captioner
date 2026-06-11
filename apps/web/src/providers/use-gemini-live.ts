import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { GeminiLiveProvider } from './gemini-live-provider.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import { DisplayMediaAudioProvider } from './display-media-audio-provider.js';
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
      if ((ev.state === 'failed' || ev.state === 'api_error' || ev.state === 'no_audio_track') && ev.message) {
        setError(ev.message);
      }
    };
    handlersRef.current = handlers;
    // Honour the user's audio-source selection, mirroring the OpenAI hook:
    // 'system' captures Teams/Zoom via getDisplayMedia (mic DSP profile is
    // irrelevant there — the signal is pre-mixed), 'mic' uses getUserMedia
    // with the selected acoustic profile. Without this branch the 🔊 chip
    // would claim system capture while Gemini silently recorded the mic.
    let audio: AudioSource;
    let effectiveMicDistance: 'meeting' | 'close' | 'far' | 'off';
    if (audioSource === 'system') {
      audio = new DisplayMediaAudioProvider();
      effectiveMicDistance = 'off';
    } else {
      audio = new MicrophoneAudioProvider(micDistance);
      effectiveMicDistance = micDistance;
    }
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

  return { status, error, geminiStatus, available: geminiStatus === 'available', start, stop };
}
