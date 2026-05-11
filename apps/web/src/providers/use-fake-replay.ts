import { useCallback, useEffect, useRef, useState } from 'react';
import { captionStore } from '../store/use-caption-store.js';
import {
  FakeReplayProvider,
  FakeReplayScript,
  type FakeReplayScript as FakeReplayScriptType,
} from './fake-replay-provider.js';
import type { ProviderStatus } from './types.js';

async function loadScript(): Promise<FakeReplayScriptType> {
  const mod = await import('../dev/fake-transcript.json');
  return FakeReplayScript.parse(mod.default);
}

export function useFakeReplay() {
  const providerRef = useRef<FakeReplayProvider | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => providerRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const script = await loadScript();
      captionStore.getState().clear();
      const provider = new FakeReplayProvider(script, {
        onTranscript: (e) => captionStore.getState().applyTranscript(e),
        onTranslation: (e) => captionStore.getState().applyTranslation(e),
      });
      providerRef.current = provider;
      provider.start();
      setStatus('running');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    setStatus('stopped');
  }, []);

  return { status, error, start, stop };
}
