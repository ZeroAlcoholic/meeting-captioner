import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { describe, expect, it } from 'vitest';
import { createCaptionStore } from './caption-store.js';
import {
  HISTORY_RENDER_SEGMENTS,
  groupParagraphsForSide,
  tailSegments,
} from '../caption-board/paragraph-grouping.js';

/**
 * Sustained-load SOAK for the caption store + render-feed path.
 *
 * The single-burst bounds tests in caption-store.test.ts prove the ring buffer
 * caps at maxSegments and prunes orphan translations. This file instead drives a
 * realistic LONG meeting — thousands of interleaved partial→final turns with
 * draft→final translations, across simulated session renewals — and asserts the
 * invariants that actually protect a multi-hour meeting from degrading:
 *
 *   1. segments[] reference is STABLE across partial deltas (the live/final
 *      split's whole reason to exist — if it churned, HistoryStream would
 *      re-group paragraphs on every keystroke-rate delta and the board would
 *      visibly lag late in a meeting).
 *   2. segments length stays ≤ maxSegments for the WHOLE run, not just at the end.
 *   3. translations never accumulate orphans beyond the live window.
 *   4. the render feed (tailSegments → groupParagraphsForSide) stays bounded by
 *      HISTORY_RENDER_SEGMENTS regardless of total history — bounding DOM/CPU.
 *
 * We assert STRUCTURAL bounds (array lengths, reference identity) rather than raw
 * heap samples: structural caps are the deterministic contract; process heap is
 * noisy under GC and would make the test flaky.
 */

const baseTranscript = {
  kind: 'transcript' as const,
  provider: 'openai-realtime',
  mode: 'online_full' as const,
  source: 'microphone' as const,
};

function partial(segmentId: string, text: string, startMs: number): TranscriptEvent {
  return { ...baseTranscript, segmentId, status: 'partial', text, startMs };
}
function final(segmentId: string, text: string, startMs: number): TranscriptEvent {
  return { ...baseTranscript, segmentId, status: 'final', text, startMs, endMs: startMs + 1000 };
}
function draft(sourceSegmentId: string, targetText: string): TranslationEvent {
  return {
    kind: 'translation',
    provider: 'openai-realtime',
    mode: 'online_full',
    sourceSegmentId,
    status: 'draft',
    sourceText: 'src',
    targetText,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-06-12T00:00:00.000Z',
  };
}
function finalTr(sourceSegmentId: string, targetText: string): TranslationEvent {
  return { ...draft(sourceSegmentId, targetText), status: 'final' };
}

describe('captionStore — sustained-load soak', () => {
  it('holds all bounds + reference invariants across a long interleaved meeting', () => {
    // Buffer cap intentionally ABOVE the render cap so the soak exercises BOTH
    // the store ring buffer (maxSegments) AND the render-feed cap
    // (HISTORY_RENDER_SEGMENTS) — the tail must clamp to 400 even though the
    // store holds up to 600.
    const maxSegments = 600;
    const store = createCaptionStore({ maxSegments, persistKey: null });
    const TURNS = 5_000;

    let startMs = 0;
    let maxSegLenSeen = 0;
    let maxTrCountSeen = 0;
    let maxTailLenSeen = 0;

    for (let turn = 0; turn < TURNS; turn++) {
      const id = `seg-${turn}`;
      startMs += 1500;

      // Reference captured BEFORE this turn's partial stream. Each partial delta
      // (livePartial-only update) must NOT change the segments[] reference.
      const segRefBeforePartials = store.getState().segments;

      // 3 streaming source deltas + 3 streaming translation drafts (the hot path).
      let acc = '';
      for (let d = 0; d < 3; d++) {
        acc += d === 0 ? 'Streaming ' : `word${d} `;
        store.getState().applyTranscript(partial(id, acc.trim() + '.', startMs));
        store.getState().applyTranslation(draft(id, `串流第${d}字。`));
        // Invariant 1: partial deltas never rewrite history.
        expect(store.getState().segments).toBe(segRefBeforePartials);
      }

      // Finalize the turn (transcript final + translation final).
      store.getState().applyTranscript(final(id, acc.trim() + '.', startMs));
      store.getState().applyTranslation(finalTr(id, `串流定稿${turn}。`));

      const st = store.getState();

      // Invariant 2: ring buffer cap holds at EVERY step, not just the end.
      expect(st.segments.length).toBeLessThanOrEqual(maxSegments);
      // Invariant 3: translations track the live window (small constant slack for
      // an in-flight liveTranslation that hasn't been promoted/pruned yet).
      expect(Object.keys(st.translations).length).toBeLessThanOrEqual(st.segments.length + 1);
      // The finalized turn cleared the live partial.
      expect(st.livePartial).toBeNull();

      // Invariant 4: the render feed is bounded regardless of total history.
      const tail = tailSegments(st.segments, HISTORY_RENDER_SEGMENTS);
      expect(tail.length).toBeLessThanOrEqual(HISTORY_RENDER_SEGMENTS);
      // Under the render cap, tailSegments must return the SAME array reference
      // (no needless copy → no needless paragraph re-grouping).
      if (st.segments.length <= HISTORY_RENDER_SEGMENTS) {
        expect(tail).toBe(st.segments);
      }

      maxSegLenSeen = Math.max(maxSegLenSeen, st.segments.length);
      maxTrCountSeen = Math.max(maxTrCountSeen, Object.keys(st.translations).length);
      maxTailLenSeen = Math.max(maxTailLenSeen, tail.length);
    }

    const end = store.getState();
    // The buffer actually filled and stayed capped (not silently small).
    expect(maxSegLenSeen).toBe(maxSegments);
    expect(maxTrCountSeen).toBeLessThanOrEqual(maxSegments + 1);
    expect(maxTailLenSeen).toBe(HISTORY_RENDER_SEGMENTS);

    // Eviction kept the NEWEST window: oldest gone, newest present.
    expect(end.segments[0]?.segmentId).toBe(`seg-${TURNS - maxSegments}`);
    expect(end.segments[end.segments.length - 1]?.segmentId).toBe(`seg-${TURNS - 1}`);

    // Paragraph grouping over the rendered tail is itself bounded (no run-away
    // paragraph explosion): one paragraph per segment is the worst case.
    const paras = groupParagraphsForSide({
      segments: tailSegments(end.segments, HISTORY_RENDER_SEGMENTS),
      translations: end.translations,
      side: 'zh',
      accessor: (s, t) => t?.targetText ?? s.text,
    });
    expect(paras.length).toBeLessThanOrEqual(HISTORY_RENDER_SEGMENTS);
  });

  it('stays bounded across many session renewals (begin/clear churn)', () => {
    const maxSegments = 50;
    const store = createCaptionStore({ maxSegments, persistKey: null });

    for (let session = 0; session < 200; session++) {
      store.getState().beginSession(session % 2 === 0 ? 'real' : 'gemini');
      let startMs = 0;
      for (let i = 0; i < 120; i++) {
        const id = `s${session}-${i}`;
        startMs += 1000;
        store.getState().applyTranscript(partial(id, 'x', startMs));
        store.getState().applyTranscript(final(id, 'x.', startMs));
        store.getState().applyTranslation(finalTr(id, 'y。'));
      }
      const st = store.getState();
      // Each session independently respects the cap; beginSession reset history.
      expect(st.segments.length).toBe(maxSegments);
      expect(st.segments[0]?.segmentId).toBe(`s${session}-${120 - maxSegments}`);
      expect(Object.keys(st.translations).length).toBeLessThanOrEqual(maxSegments + 1);
    }
  });
});
