import { useCallback, useEffect, useRef, useState } from 'react';
import { OFFLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { OfflineSTTProvider } from './offline-stt-provider.js';
import type { ProviderStatus } from './types.js';

const HEALTHZ_URL = `${OFFLINE_SERVICE_URL}/healthz`;
const WS_URL = `${OFFLINE_SERVICE_URL.replace(/^http/, 'ws')}/ws`;

interface OfflineHealthz {
  ok: boolean;
  whisper_status: string;
}

export function useOfflineSTT() {
  const providerRef = useRef<OfflineSTTProvider | null>(null);
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
    captionStore.getState().clear();

    const { langPair, audioSource } = settingsStore.getState();

    const provider = new OfflineSTTProvider(WS_URL, {
      onTranscript: (e) => captionStore.getState().applyTranscript(e),
      onTranslation: (e) => captionStore.getState().applyTranslation(e),
      onHealth: (e) => settingsStore.getState().applyHealth(e),
      onAudioLevel: (e) => settingsStore.getState().applyAudioLevel(e),
    }, undefined, langPair, audioSource);
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      if (provider.status === 'stopped') {
        setStatus('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    setStatus('stopped');
  }, []);

  const hasWhisper = whisperStatus === 'ready';

  return { status, error, whisperStatus, hasWhisper, start, stop };
}
