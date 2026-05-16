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
    const poll = () => {
      fetch(HEALTHZ_URL)
        .then((r) => r.json())
        .then((d: OfflineHealthz) => { if (!cancelled) setWhisperStatus(d.whisper_status); })
        .catch(() => { if (!cancelled) setWhisperStatus('unavailable'); });
    };
    poll();
    // Re-poll every 3s so UI auto-updates when WHL becomes ready (e.g., after model download).
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
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
