import { describe, expect, it } from 'vitest';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import {
  formatElapsedFromStart,
  groupParagraphsForSide,
  tailSegments,
} from './paragraph-grouping.js';

const THIN_SPACE = ' ';

function seg(
  id: string,
  text: string,
  startMs: number,
  opts: Partial<CaptionSegment> = {},
): CaptionSegment {
  return {
    segmentId: id,
    provider: 'fake',
    source: 'fake_replay',
    mode: 'full_offline',
    status: 'final',
    text,
    startMs,
    endMs: opts.endMs ?? startMs + 1000,
    ...opts,
  };
}

function tr(sourceSegmentId: string, sourceText: string, targetText: string): CaptionTranslation {
  return {
    sourceSegmentId,
    provider: 'fake',
    status: 'final',
    sourceText,
    targetText,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-05-15T00:00:00.000Z',
  };
}

describe('groupParagraphsForSide — EN side', () => {
  it('breaks paragraphs at sentence-ending punctuation', () => {
    const segments = [
      seg('a', "OK so let's pick up.", 0),
      seg('b', "I think we're ready.", 1500),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe("OK so let's pick up.");
    expect(out[1]?.text).toBe("I think we're ready.");
  });

  it('merges consecutive segments when prior lacks sentence-end', () => {
    const segments = [
      seg('a', "OK so let's pick up where we left off", 0),
      seg('b', 'on the roadmap.', 1200),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("OK so let's pick up where we left off on the roadmap.");
  });

  it('does NOT inject a leading space before em-dash / period continuations', () => {
    const segments = [
      seg('a', 'Yeah, but we still need to confirm the path on Windows', 0),
      seg('b', '— should that be bundled?', 1100),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('Yeah, but we still need to confirm the path on Windows— should that be bundled?');
  });
});

describe('groupParagraphsForSide — ZH side', () => {
  it('breaks at 「。！？」 but NOT at mid-sentence comma 「，」', () => {
    const segments = [
      seg('a', '我們今天先把 P4 的範圍確認清楚。', 0),
      seg('b', 'WASAPI loopback 是必做的，', 2000),
      seg('c', 'Teams 跟 Zoom 兩邊都需要。', 3500),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'zh',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe('我們今天先把 P4 的範圍確認清楚。');
    // Comma 「，」 in segment b does NOT end the sentence, so b+c merge.
    // CJK 「，」 ↔ ASCII 「T」 → fallthrough chooses regular space (Latin word boundary).
    expect(out[1]?.text).toMatch(/^WASAPI loopback 是必做的，.*Teams 跟 Zoom 兩邊都需要。$/);
  });

  it('uses U+2009 thin space when merging two CJK-adjacent segments', () => {
    const segments = [
      seg('a', '好，我們從上次中斷的路線圖繼續', 0),         // no 「。」 → merges
      seg('b', '我覺得 offline 流水線下週可以開始。', 1100),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'zh',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(1);
    // Adjacent CJK chars 「續」+「我」 should be joined by U+2009 thin space — visible breath but no injected punctuation.
    expect(out[0]?.text).toBe('好，我們從上次中斷的路線圖繼續' + THIN_SPACE + '我覺得 offline 流水線下週可以開始。');
  });
});

describe('groupParagraphsForSide — independent split between sides', () => {
  it('produces different paragraph counts when ZH and EN end sentences at different segments', () => {
    // Segment 1: EN ends sentence (`.`), ZH does NOT (no 「。」)
    // Segment 2: EN starts new sentence, ZH continues (still no 「。」)
    // Segment 3: ZH finally ends 「。」, EN continues mid-sentence (no `.`)
    // Segment 4: EN ends 「.」
    const segments = [
      seg('a', 'A.', 0),
      seg('b', 'B starts here', 1100),
      seg('c', 'and continues', 2200),
      seg('d', 'and finally ends.', 3300),
    ];
    const translations: Record<string, CaptionTranslation> = {
      a: tr('a', 'A.', '甲'),
      b: tr('b', 'B starts here', '乙開始'),
      c: tr('c', 'and continues', '繼續。'),
      d: tr('d', 'and finally ends.', '結束'),
    };
    const en = groupParagraphsForSide({
      segments,
      translations,
      side: 'en',
      accessor: (s) => s.text,
    });
    const zh = groupParagraphsForSide({
      segments,
      translations,
      side: 'zh',
      accessor: (_s, t) => t?.targetText ?? '',
    });
    expect(en).toHaveLength(2); // ['A.', 'B starts here and continues and finally ends.']
    expect(zh).toHaveLength(2); // [merged through to 「繼續。」, '結束']
    expect(en[0]?.text).toBe('A.');
    expect(en[1]?.text).toBe('B starts here and continues and finally ends.');
    expect(zh[0]?.text).toMatch(/繼續。$/);
    expect(zh[1]?.text).toBe('結束');
  });
});

describe('groupParagraphsForSide — paragraph cap and gap break', () => {
  it('breaks paragraph when gap exceeds PARAGRAPH_GAP_MS even without punctuation', () => {
    const segments = [
      seg('a', 'first chunk', 0,    { endMs: 800 }),
      seg('b', 'second chunk', 5000, { endMs: 5800 }), // 4.2s gap from prev paragraph end
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(2);
  });
});

describe('confidence dim flag', () => {
  it('marks paragraph confLow=true if any constituent segment has confidence < threshold', () => {
    const segments = [
      seg('a', 'high conf piece', 0,    { confidence: 0.9 }),
      seg('b', 'low conf piece',  1100, { confidence: 0.4 }),
    ];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.confLow).toBe(true);
  });

  it('confLow stays false when all segments are above threshold', () => {
    const segments = [seg('a', 'fine.', 0, { confidence: 0.95 })];
    const out = groupParagraphsForSide({
      segments,
      translations: {},
      side: 'en',
      accessor: (s) => s.text,
    });
    expect(out[0]?.confLow).toBe(false);
  });
});

describe('formatElapsedFromStart', () => {
  it('returns 0:00 when sessionStartMs is null', () => {
    expect(formatElapsedFromStart(123456, null)).toBe('0:00');
  });

  it('formats elapsed time as M:SS', () => {
    const start = 1_700_000_000_000;
    expect(formatElapsedFromStart(start, start)).toBe('0:00');
    expect(formatElapsedFromStart(start + 30_000, start)).toBe('0:30');
    expect(formatElapsedFromStart(start + 90_000, start)).toBe('1:30');
    expect(formatElapsedFromStart(start + 615_000, start)).toBe('10:15');
  });

  it('clamps negative elapsed to 0:00 (defensive against clock skew)', () => {
    const start = 1_700_000_000_000;
    expect(formatElapsedFromStart(start - 5000, start)).toBe('0:00');
  });
});

describe('tailSegments — history render cap', () => {
  const make = (n: number): CaptionSegment[] =>
    Array.from({ length: n }, (_, i) => seg(`s${i}`, `line ${i}`, i * 1000));

  it('returns the SAME reference when within the cap (lets useMemo skip work)', () => {
    const segs = make(10);
    expect(tailSegments(segs, 400)).toBe(segs);
    // Exactly at the cap is still within — no copy.
    const exact = make(400);
    expect(tailSegments(exact, 400)).toBe(exact);
  });

  it('keeps only the most-recent N segments when over the cap', () => {
    const segs = make(450);
    const tail = tailSegments(segs, 400);
    expect(tail).toHaveLength(400);
    // Oldest 50 dropped; the window ends at the newest segment.
    expect(tail[0]!.segmentId).toBe('s50');
    expect(tail.at(-1)!.segmentId).toBe('s449');
  });

  it('does not mutate the source array (full history stays intact for Export)', () => {
    const segs = make(450);
    tailSegments(segs, 400);
    expect(segs).toHaveLength(450);
    expect(segs[0]!.segmentId).toBe('s0');
  });

  it('limit <= 0 disables the cap (returns the full array)', () => {
    const segs = make(450);
    expect(tailSegments(segs, 0)).toBe(segs);
    expect(tailSegments(segs, -1)).toBe(segs);
  });
});
