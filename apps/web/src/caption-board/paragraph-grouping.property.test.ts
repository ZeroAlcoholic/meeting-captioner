import { describe, expect, it } from 'vitest';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import {
  HISTORY_RENDER_SEGMENTS,
  groupParagraphsForSide,
  tailSegments,
} from './paragraph-grouping.js';

/**
 * Randomized property tests for the render-feed pure functions. A tiny seeded
 * PRNG keeps them fully deterministic (no fast-check dependency — CLAUDE.md
 * prefers small/stable deps), while still sweeping hundreds of shapes per run
 * that hand-written examples would miss.
 */

// mulberry32 — deterministic, well-distributed 32-bit PRNG.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH_WORDS = ['營收', '成長', '我們', '本季', '專案', '完成', '會議', '討論'];
const EN_WORDS = ['revenue', 'grew', 'the', 'project', 'is', 'done', 'meeting', 'review'];
const ZH_ENDERS = ['。', '！', '？', '…'];
const EN_ENDERS = ['.', '!', '?', '…'];

function randomSegments(rand: () => number): { segments: CaptionSegment[]; translations: Record<string, CaptionTranslation> } {
  const n = Math.floor(rand() * 30);
  const segments: CaptionSegment[] = [];
  const translations: Record<string, CaptionTranslation> = {};
  let startMs = Math.floor(rand() * 1000);
  for (let i = 0; i < n; i++) {
    // Gaps occasionally exceed PARAGRAPH_GAP_MS (1500) to force paragraph breaks.
    startMs += Math.floor(rand() * 2500);
    const id = `seg-${i}`;
    const words = Math.floor(rand() * 6);
    let en = '';
    let zh = '';
    for (let w = 0; w < words; w++) {
      en += (en ? ' ' : '') + EN_WORDS[Math.floor(rand() * EN_WORDS.length)];
      zh += ZH_WORDS[Math.floor(rand() * ZH_WORDS.length)];
    }
    // Sometimes terminate the sentence, sometimes leave it open (run-on → merge).
    if (rand() < 0.5 && en) en += EN_ENDERS[Math.floor(rand() * EN_ENDERS.length)];
    if (rand() < 0.5 && zh) zh += ZH_ENDERS[Math.floor(rand() * ZH_ENDERS.length)];
    const seg: CaptionSegment = {
      segmentId: id,
      provider: 'fake',
      source: 'microphone',
      mode: 'online_full',
      status: 'final',
      text: en,
      startMs,
      endMs: startMs + Math.floor(rand() * 1200),
    };
    // ~25% of segments carry a low-confidence score.
    if (rand() < 0.25) seg.confidence = rand() * 0.6; // < CONF_LOW_THRESHOLD
    else if (rand() < 0.5) seg.confidence = 0.6 + rand() * 0.4;
    segments.push(seg);
    if (zh) {
      translations[id] = {
        sourceSegmentId: id,
        provider: 'fake',
        status: 'final',
        sourceText: en,
        targetText: zh,
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hant',
        updatedAt: '2026-06-12T00:00:00.000Z',
      };
    }
  }
  return { segments, translations };
}

describe('tailSegments — properties', () => {
  it('length, suffix-identity and reference-stability hold for all shapes', () => {
    const rand = rng(0xc0ffee);
    for (let iter = 0; iter < 500; iter++) {
      const len = Math.floor(rand() * 60);
      const segments: CaptionSegment[] = Array.from({ length: len }, (_, i) => ({
        segmentId: `s${i}`, provider: 'p', source: 'microphone', mode: 'online_full',
        status: 'final', text: `t${i}`, startMs: i,
      }));
      // Limit spans negative, zero, in-range and over-range.
      const limit = Math.floor(rand() * 80) - 5;
      const out = tailSegments(segments, limit);

      if (limit <= 0 || len <= limit) {
        // No cap applies → SAME reference (the useMemo fast path).
        expect(out).toBe(segments);
      } else {
        expect(out.length).toBe(limit);
        // It's the SUFFIX: out[k] === segments[len-limit+k].
        const offset = len - limit;
        for (let k = 0; k < out.length; k++) expect(out[k]).toBe(segments[offset + k]);
      }
      // Length is always min(len, limit) for positive limits.
      if (limit > 0) expect(out.length).toBe(Math.min(len, limit));
    }
  });

  it('caps the render feed to HISTORY_RENDER_SEGMENTS for over-long histories', () => {
    const rand = rng(7);
    for (let iter = 0; iter < 50; iter++) {
      const len = HISTORY_RENDER_SEGMENTS + Math.floor(rand() * 2000);
      const segments: CaptionSegment[] = Array.from({ length: len }, (_, i) => ({
        segmentId: `s${i}`, provider: 'p', source: 'microphone', mode: 'online_full',
        status: 'final', text: 't', startMs: i,
      }));
      const out = tailSegments(segments, HISTORY_RENDER_SEGMENTS);
      expect(out.length).toBe(HISTORY_RENDER_SEGMENTS);
      expect(out[out.length - 1]?.segmentId).toBe(`s${len - 1}`); // newest retained
    }
  });
});

describe('groupParagraphsForSide — properties', () => {
  for (const side of ['en', 'zh'] as const) {
    it(`(${side}) preserves content, order and confidence; bounds paragraph count`, () => {
      const rand = rng(side === 'en' ? 0x1111 : 0x2222);
      const accessor =
        side === 'en'
          ? (s: CaptionSegment) => s.text
          : (s: CaptionSegment, t?: CaptionTranslation) => t?.targetText ?? '';

      for (let iter = 0; iter < 400; iter++) {
        const { segments, translations } = randomSegments(rand);
        const paras = groupParagraphsForSide({ segments, translations, side, accessor });

        const nonEmpty = segments.filter((s) => accessor(s, translations[s.segmentId]).trim().length > 0);

        // 1. Never more paragraphs than contributing segments.
        expect(paras.length).toBeLessThanOrEqual(nonEmpty.length);
        // An empty input side yields no paragraphs.
        if (nonEmpty.length === 0) expect(paras.length).toBe(0);

        // 2. Chronological order preserved (input is startMs-sorted).
        for (let i = 1; i < paras.length; i++) {
          expect(paras[i]!.startMs).toBeGreaterThanOrEqual(paras[i - 1]!.startMs);
        }

        // 3. Each paragraph is well-formed: endMs >= startMs, non-empty text.
        for (const p of paras) {
          expect(p.endMs).toBeGreaterThanOrEqual(p.startMs);
          expect(p.text.length).toBeGreaterThan(0);
        }

        // 4. Content preservation: every contributing segment's trimmed piece is a
        //    contiguous substring of exactly one paragraph (nothing dropped/garbled).
        for (const s of nonEmpty) {
          const piece = accessor(s, translations[s.segmentId]).trim();
          const hits = paras.filter((p) => p.text.includes(piece));
          expect(hits.length).toBeGreaterThanOrEqual(1);
        }

        // 5. Low-confidence flag is faithful: it is set iff some contributing
        //    segment was low-confidence.
        const anyLow = nonEmpty.some((s) => s.confidence !== undefined && s.confidence < 0.6);
        const anyParaLow = paras.some((p) => p.confLow);
        expect(anyParaLow).toBe(anyLow);
      }
    });
  }
});
