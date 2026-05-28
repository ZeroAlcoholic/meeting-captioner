/**
 * Tests for the translateOnline helper (Hybrid Privacy mode).
 *
 * Key invariant: when translation fails (network error, 429, 502, timeout),
 * translateOnline returns null — so the caption path (already applied before
 * the translation attempt) is never blocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEvent } from '@meeting-audio/contracts';
import { translateOnline } from './use-hybrid-mode.js';

const FINAL_TRANSCRIPT: TranscriptEvent = {
  kind: 'transcript',
  provider: 'offline-stt',
  mode: 'full_offline',
  source: 'microphone',
  segmentId: 'seg-001',
  status: 'final',
  text: 'The policyholder must sign.',
  startMs: 500,
  endMs: 2000,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('translateOnline error resilience', () => {
  it('returns null on 429 rate-limit — caption path unblocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const result = await translateOnline(FINAL_TRANSCRIPT, 'en→zh-TW');
    expect(result).toBeNull();
  });

  it('returns null on 502 upstream error — caption path unblocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const result = await translateOnline(FINAL_TRANSCRIPT, 'en→zh-TW');
    expect(result).toBeNull();
  });

  it('returns null on network failure — caption path unblocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));
    const result = await translateOnline(FINAL_TRANSCRIPT, 'en→zh-TW');
    expect(result).toBeNull();
  });

  it('returns null when response body has empty targetText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ targetText: '' }),
      }),
    );
    const result = await translateOnline(FINAL_TRANSCRIPT, 'en→zh-TW');
    expect(result).toBeNull();
  });

  it('returns TranslationEvent on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ targetText: '要保人必須簽署。' }),
      }),
    );
    const result = await translateOnline(FINAL_TRANSCRIPT, 'en→zh-TW');
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('translation');
    expect(result?.targetText).toBe('要保人必須簽署。');
    expect(result?.sourceLanguage).toBe('en');
    expect(result?.targetLanguage).toBe('zh-TW');
    expect(result?.mode).toBe('hybrid_privacy');
  });

  it('routes zh-TW→en correctly (sourceLang=zh, targetLang=en)', async () => {
    const zhTranscript: TranscriptEvent = { ...FINAL_TRANSCRIPT, text: '要保人必須簽署。' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ targetText: 'The policyholder must sign.' }),
      }),
    );
    const result = await translateOnline(zhTranscript, 'zh-TW→en');
    expect(result?.sourceLanguage).toBe('zh');
    expect(result?.targetLanguage).toBe('en');
  });
});
