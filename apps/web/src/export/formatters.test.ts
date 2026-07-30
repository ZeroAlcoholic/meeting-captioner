import { describe, expect, it } from 'vitest';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import {
  buildExport,
  toJson,
  toMarkdown,
  toPlainText,
  toSrt,
  type SessionMetadata,
} from './formatters.js';

const SESSION_START = 1_700_000_000_000;

function seg(
  id: string,
  text: string,
  startOffsetMs: number,
  endOffsetMs?: number,
): CaptionSegment {
  const s: CaptionSegment = {
    segmentId: id,
    provider: 'fake',
    source: 'fake_replay',
    mode: 'full_offline',
    status: 'final',
    text,
    startMs: SESSION_START + startOffsetMs,
  };
  if (endOffsetMs !== undefined) s.endMs = SESSION_START + endOffsetMs;
  return s;
}

function tr(sourceSegmentId: string, targetText: string): CaptionTranslation {
  return {
    sourceSegmentId,
    provider: 'fake',
    status: 'final',
    sourceText: '',
    targetText,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-05-19T00:00:00.000Z',
  };
}

function meta(
  segments: CaptionSegment[],
  translations: Record<string, CaptionTranslation> = {},
  sessionStartMs: number | null = SESSION_START,
): SessionMetadata {
  return { segments, translations, sessionStartMs };
}

describe('toPlainText', () => {
  it('returns empty string for empty store', () => {
    expect(toPlainText(meta([]))).toBe('');
  });

  it('joins source-only segments with blank lines', () => {
    const out = toPlainText(meta([seg('a', 'Hello.', 0), seg('b', 'World.', 5000)]));
    expect(out).toBe('Hello.\n\nWorld.');
  });

  it('emits source then translation per segment when both present', () => {
    const out = toPlainText(
      meta([seg('a', 'Hello.', 0), seg('b', 'World.', 5000)], {
        a: tr('a', '你好。'),
        b: tr('b', '世界。'),
      }),
    );
    expect(out).toBe('Hello.\n你好。\n\nWorld.\n世界。');
  });

  it('respects includeSource=false (translation-only export)', () => {
    const out = toPlainText(meta([seg('a', 'Hello.', 0)], { a: tr('a', '你好。') }), {
      includeSource: false,
    });
    expect(out).toBe('你好。');
  });

  it('respects includeTranslation=false (source-only export)', () => {
    const out = toPlainText(meta([seg('a', 'Hello.', 0)], { a: tr('a', '你好。') }), {
      includeTranslation: false,
    });
    expect(out).toBe('Hello.');
  });

  it('omits segments that produce no lines after filtering', () => {
    const out = toPlainText(meta([seg('a', 'Hello.', 0)], {}), {
      includeSource: false,
      includeTranslation: true,
    });
    expect(out).toBe('');
  });
});

describe('toSrt', () => {
  it('returns empty string for empty store', () => {
    expect(toSrt(meta([]))).toBe('');
  });

  it('formats timing as HH:MM:SS,mmm and numbers cues from 1', () => {
    const out = toSrt(meta([seg('a', 'Hi.', 0, 1500)]));
    expect(out).toMatch(/^1\n00:00:00,000 --> 00:00:01,500\nHi\.\n$/);
  });

  it('falls back to next segment startMs when endMs is missing', () => {
    const out = toSrt(meta([seg('a', 'One.', 0), seg('b', 'Two.', 4000)]));
    // First cue should end 1ms before next cue starts (3999ms)
    expect(out).toContain('00:00:00,000 --> 00:00:03,999');
    expect(out).toContain('00:00:04,000 --> 00:00:06,000'); // last cue: +2s default
  });

  it('handles cross-hour durations (HH > 0)', () => {
    const out = toSrt(meta([seg('a', 'Late.', 3_661_000, 3_662_000)]));
    expect(out).toContain('01:01:01,000 --> 01:01:02,000');
  });

  it('stacks source and translation in one cue when both included', () => {
    const out = toSrt(meta([seg('a', 'Hello.', 0, 1000)], { a: tr('a', '你好。') }));
    expect(out).toContain('Hello.\n你好。');
  });

  it('terminates with a trailing newline when at least one cue exists', () => {
    const out = toSrt(meta([seg('a', 'A.', 0, 1000)]));
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('toMarkdown', () => {
  it('emits header even for empty store', () => {
    const out = toMarkdown(meta([]));
    expect(out).toContain('# Meeting Transcript');
    expect(out).toContain('0 segments');
  });

  it('uses M:SS timestamps under one hour, H:MM:SS over', () => {
    const out = toMarkdown(meta([seg('a', 'Early.', 65_000), seg('b', 'Later.', 3_725_000)]));
    expect(out).toContain('**[1:05]** Early.');
    expect(out).toContain('**[1:02:05]** Later.');
  });

  it('renders translation as a blockquote under source', () => {
    const out = toMarkdown(meta([seg('a', 'Hello.', 0)], { a: tr('a', '你好。') }));
    expect(out).toContain('**[0:00]** Hello.');
    expect(out).toContain('> 你好。');
  });

  it('shows translation as primary line when includeSource=false', () => {
    const out = toMarkdown(meta([seg('a', 'Hello.', 0)], { a: tr('a', '你好。') }), {
      includeSource: false,
    });
    expect(out).toContain('**[0:00]** 你好。');
    expect(out).not.toContain('Hello.');
  });

  it('falls back to "(unknown)" started label when sessionStartMs is null', () => {
    const out = toMarkdown(meta([seg('a', 'A.', 0)], {}, null));
    expect(out).toContain('Started: (unknown)');
  });
});

describe('toJson', () => {
  it('round-trips through JSON.parse and preserves segment metadata', () => {
    const segs = [seg('a', 'Hi.', 0, 1000)];
    segs[0]!.confidence = 0.87;
    const out = toJson(meta(segs, { a: tr('a', '嗨。') }));
    const parsed = JSON.parse(out);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0].segmentId).toBe('a');
    expect(parsed.segments[0].confidence).toBe(0.87);
    expect(parsed.translations.a.targetText).toBe('嗨。');
    expect(parsed.sessionStartMs).toBe(SESSION_START);
  });

  it('always carries exportedAt', () => {
    const parsed = JSON.parse(toJson(meta([])));
    expect(typeof parsed.exportedAt).toBe('string');
    expect(new Date(parsed.exportedAt).toString()).not.toBe('Invalid Date');
  });
});

describe('buildExport', () => {
  it('returns a stable filename rooted in sessionStartMs', () => {
    const a = buildExport(meta([seg('s', 'x', 0)]), 'txt');
    expect(a.filename).toMatch(/^meeting-.+\.txt$/);
    expect(a.mime).toContain('text/plain');
  });

  it('picks the right mime + extension per format', () => {
    expect(buildExport(meta([]), 'srt').filename.endsWith('.srt')).toBe(true);
    expect(buildExport(meta([]), 'srt').mime).toContain('subrip');
    expect(buildExport(meta([]), 'md').filename.endsWith('.md')).toBe(true);
    expect(buildExport(meta([]), 'md').mime).toContain('markdown');
    expect(buildExport(meta([]), 'json').filename.endsWith('.json')).toBe(true);
    expect(buildExport(meta([]), 'json').mime).toContain('json');
  });

  it('falls back to now() when sessionStartMs is null', () => {
    const a = buildExport(meta([], {}, null), 'txt');
    expect(a.filename).toMatch(/^meeting-.+\.txt$/);
  });
});
