/**
 * Hybrid Privacy mode: local STT (WhisperLiveKit via offline service) +
 * online translation (GPT-4o-mini via online service).
 *
 * Audio never leaves the machine. Only the finalized transcript text is
 * sent to the online service for higher-quality translation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { OFFLINE_SERVICE_URL, ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { OfflineSTTProvider } from './offline-stt-provider.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { ProviderStatus } from './types.js';

const HEALTHZ_URL = `${OFFLINE_SERVICE_URL}/healthz`;
const WS_URL = `${OFFLINE_SERVICE_URL.replace(/^http/, 'ws')}/ws`;
const TRANSLATE_URL = `${ONLINE_SERVICE_URL}/translate`;

interface OfflineHealthz {
  ok: boolean;
  whisper_status: string;
}

export async function translateOnline(
  ev: TranscriptEvent,
  langPair: string,
): Promise<TranslationEvent | null> {
  const isEnZh = langPair.startsWith('en');
  const sourceLang = isEnZh ? 'en' : 'zh';
  const targetLang = isEnZh ? 'zh-TW' : 'en';

  try {
    const res = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentId: ev.segmentId, text: ev.text, sourceLang, targetLang }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { targetText: string };
    if (!data.targetText) return null;

    return {
      kind: 'translation',
      provider: 'hybrid',
      mode: 'hybrid_privacy',
      sourceSegmentId: ev.segmentId,
      status: 'final',
      sourceText: ev.text,
      targetText: data.targetText,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function useHybridMode() {
  const providerRef = useRef<OfflineSTTProvider | null>(null);
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [whisperStatus, setWhisperStatus] = useState<string | null>(null);

  // Same healthz polling as useOfflineSTT — hybrid still needs the offline service
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
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
    const baseHandlers = createStoreBoundHandlers();
    handlersRef.current = baseHandlers;

    // Intercept final transcript events — fire online translation
    // after forwarding the transcript to the caption store.
    const hybridHandlers = {
      ...baseHandlers,
      onTranscript(ev: TranscriptEvent) {
        baseHandlers.onTranscript(ev);
        if (ev.status === 'final') {
          void translateOnline(ev, langPair).then((translationEv) => {
            if (translationEv) captionStore.getState().applyTranslation(translationEv);
          });
        }
      },
    };

    // translate: false — offline service does STT only; browser handles MT
    const provider = new OfflineSTTProvider(WS_URL, hybridHandlers, undefined, langPair, audioSource, false);
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      if (providerRef.current !== provider) return;
      if (provider.status === 'stopped') setStatus('idle');
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
