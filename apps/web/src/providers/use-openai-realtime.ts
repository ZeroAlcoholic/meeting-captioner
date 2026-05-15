import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import type { ProviderStatus } from './types.js';

const SESSION_URL = `${ONLINE_SERVICE_URL}/session`;
const SESSION_INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

export type ApiKeyStatus = 'checking' | 'present' | 'no-key' | 'service-down';

export function useOpenAIRealtime() {
  const providerRef = useRef<OpenAIRealtimeProvider | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('checking');

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch(SESSION_INFO_URL)
        .then((r) => r.json())
        .then((d: { hasApiKey: boolean }) => {
          if (cancelled) return;
          setApiKeyStatus(d.hasApiKey ? 'present' : 'no-key');
        })
        .catch(() => { if (!cancelled) setApiKeyStatus('service-down'); });
    };
    poll();
    // Re-poll every 3 s so UI auto-updates when service comes up or key is set.
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

    const { langPair } = settingsStore.getState();
    const provider = new OpenAIRealtimeProvider(
      SESSION_URL,
      {
        onTranscript: (e) => captionStore.getState().applyTranscript(e),
        onTranslation: (e) => captionStore.getState().applyTranslation(e),
        onHealth: (e) => settingsStore.getState().applyHealth(e),
        onAudioLevel: (e) => settingsStore.getState().applyAudioLevel(e),
      },
      langPair,
    );
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      // If provider stopped itself due to error (api_error, ICE failed), reflect that
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

  return { status, error, apiKeyStatus, start, stop };
}
