import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FakeReplayProvider,
  FakeReplayScript,
  type FakeReplayScript as FakeReplayScriptType,
} from './fake-replay-provider.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { ProviderStatus } from './types.js';

async function loadScript(): Promise<FakeReplayScriptType> {
  const mod = await import('../dev/fake-transcript.json');
  return FakeReplayScript.parse(mod.default);
}

export function useFakeReplay() {
  const providerRef = useRef<FakeReplayProvider | null>(null);
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => providerRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const previous = providerRef.current;
    if (previous && previous.status !== 'stopped') {
      previous.stop();
      handlersRef.current?.flushPending();
    }
    try {
      const script = await loadScript();
      const handlers = createStoreBoundHandlers();
      handlersRef.current = handlers;
      const provider = new FakeReplayProvider(script, handlers);
      providerRef.current = provider;
      provider.start();
      if (providerRef.current !== provider) return;
      setStatus('running');
    } catch (err) {
      if (providerRef.current !== null && providerRef.current.status === 'running') return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    handlersRef.current?.flushPending();
    setStatus('stopped');
  }, []);

  return { status, error, start, stop };
}
