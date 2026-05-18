import { useCallback, useEffect, useRef, useState } from 'react';
import { OFFLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { OfflineSTTProvider } from './offline-stt-provider.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { ProviderStatus } from './types.js';

const HEALTHZ_URL = `${OFFLINE_SERVICE_URL}/healthz`;
const WS_URL = `${OFFLINE_SERVICE_URL.replace(/^http/, 'ws')}/ws`;

interface OfflineHealthz {
  ok: boolean;
  whisper_status: string;
}

export function useOfflineSTT() {
  const providerRef = useRef<OfflineSTTProvider | null>(null);
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [whisperStatus, setWhisperStatus] = useState<string | null>(null); // null = checking

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Backoff state: tight when the service is reachable (so the UI flips to
    // "ready" promptly after model download), exponential when it's down (so
    // we don't hammer :8000 and flood the console with ERR_CONNECTION_REFUSED
    // when the user is running the online-only launcher).
    const BASE_OK_MS = 3_000;
    const FAIL_DELAYS_MS = [3_000, 6_000, 12_000, 30_000, 60_000];
    let failCount = 0;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = setTimeout(poll, delay);
    };

    const poll = () => {
      fetch(HEALTHZ_URL)
        .then((r) => r.json())
        .then((d: OfflineHealthz) => {
          if (cancelled) return;
          setWhisperStatus(d.whisper_status);
          failCount = 0;
          schedule(BASE_OK_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setWhisperStatus('unavailable');
          const idx = Math.min(failCount, FAIL_DELAYS_MS.length - 1);
          failCount += 1;
          schedule(FAIL_DELAYS_MS[idx]!);
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      providerRef.current?.stop();
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const previous = providerRef.current;
    if (previous && previous.status !== 'stopped') {
      previous.stop();
      handlersRef.current?.flushPending();
    }

    const { langPair, audioSource } = settingsStore.getState();
    const handlers = createStoreBoundHandlers();
    handlersRef.current = handlers;
    const provider = new OfflineSTTProvider(WS_URL, handlers, undefined, langPair, audioSource);
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      if (providerRef.current !== provider) return;
      if (provider.status === 'stopped') {
        setStatus('idle');
      }
    } catch (err) {
      if (providerRef.current !== provider) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    handlersRef.current?.flushPending();
    setStatus('stopped');
  }, []);

  const hasWhisper = whisperStatus === 'ready';

  return { status, error, whisperStatus, hasWhisper, start, stop };
}
