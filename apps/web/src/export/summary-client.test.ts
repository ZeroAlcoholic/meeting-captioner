import { afterEach, describe, expect, it, vi } from 'vitest';
import { installServiceFetch } from '../providers/service-fetch.js';
import { buildSummaryTranscript, requestMeetingSummary } from './summary-client.js';

afterEach(() => {
  installServiceFetch(null);
});

describe('buildSummaryTranscript', () => {
  it('formats timestamps and bilingual source | target pairs', () => {
    const out = buildSummaryTranscript(
      [
        { segmentId: '1', text: 'Underwriting p95 latency is 320ms.', startMs: 1_000_005_000 },
        { segmentId: '2', text: '核保規則確認。', startMs: 1_000_065_000 },
      ],
      {
        '1': { targetText: '核保 p95 延遲為 320 毫秒。' },
      },
      1_000_000_000,
    );
    expect(out).toBe(
      '[00:05] Underwriting p95 latency is 320ms. | 核保 p95 延遲為 320 毫秒。\n[01:05] 核保規則確認。',
    );
  });
});

describe('requestMeetingSummary', () => {
  it('calls /summarize through serviceFetch and returns normalized SummaryResult', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          summary: '【一、核心結論與重點】\n- [00:05] 核保延遲 320ms。',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          fallbackUsed: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    installServiceFetch(fakeFetch as unknown as typeof fetch);

    const result = await requestMeetingSummary({
      transcript: '[00:05] Underwriting p95 latency is 320ms.',
      preferredProvider: 'openai',
      gaps: ['00:30–00:40 收音中斷'],
    });

    expect(result).toEqual({
      summary: '【一、核心結論與重點】\n- [00:05] 核保延遲 320ms。',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      fallbackUsed: true,
    });
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/summarize');
    expect(JSON.parse(init.body as string)).toEqual({
      transcript: '[00:05] Underwriting p95 latency is 320ms.',
      preferredProvider: 'openai',
      gaps: ['00:30–00:40 收音中斷'],
    });
  });

  it('translates HTTP 401/403 into actionable Traditional Chinese message', async () => {
    installServiceFetch(
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof fetch,
    );
    await expect(requestMeetingSummary({ transcript: '[00:01] Test' })).rejects.toThrow(
      /白名單|金鑰/,
    );
  });
});
