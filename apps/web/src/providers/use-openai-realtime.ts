import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsStore } from '../settings/use-settings-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import type { ProviderStatus } from './types.js';

const SESSION_URL = 'http://localhost:8787/session';
const SESSION_INFO_URL = 'http://localhost:8787/session/info';

export function useOpenAIRealtime() {
  const providerRef = useRef<OpenAIRealtimeProvider | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null); // null = checking

  useEffect(() => {
    fetch(SESSION_INFO_URL)
      .then((r) => r.json())
      .then((d: { hasApiKey: boolean }) => setHasApiKey(d.hasApiKey))
      .catch(() => setHasApiKey(false));

    return () => {
      providerRef.current?.stop();
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    captionStore.getState().clear();

    const provider = new OpenAIRealtimeProvider(SESSION_URL, {
      onTranscript: (e) => captionStore.getState().applyTranscript(e),
      onTranslation: (e) => captionStore.getState().applyTranslation(e),
      onHealth: (e) => settingsStore.getState().applyHealth(e),
      onAudioLevel: (e) => settingsStore.getState().applyAudioLevel(e),
    });
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      // status stays 'running' while provider is active
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    setStatus('stopped');
  }, []);

  return { status, error, hasApiKey, start, stop };
}
