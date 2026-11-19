import { describe, expect, it } from 'vitest';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import { computeDisplayed } from './displayed-live.js';

const previous: CaptionSegment = {
  segmentId: 'before',
  provider: 'openai-realtime',
  source: 'microphone',
  mode: 'online_full',
  status: 'final',
  text: 'September fifteenth',
  startMs: 0,
};
const tail: CaptionSegment = {
  ...previous,
  segmentId: 'tail',
  status: 'partial',
  text: '',
  startMs: 12_000,
  continuationOf: 'before',
};
const tx = (id: string, targetText: string): CaptionTranslation => ({
  sourceSegmentId: id,
  provider: 'openai-realtime',
  status: 'final',
  sourceText: '',
  targetText,
  sourceLanguage: 'en',
  targetLanguage: 'zh-TW',
  updatedAt: '',
});

describe('bounded live continuation context', () => {
  it('keeps the date readable while the last unit is partial and after it finalizes', () => {
    expect(
      computeDisplayed(tail, previous, tx('tail', '日'), tx('before', '九月十五'))?.target,
    ).toBe('九月十五日');
    expect(
      computeDisplayed(
        null,
        { ...tail, status: 'final' },
        undefined,
        tx('tail', '日'),
        previous,
        tx('before', '九月十五'),
      )?.target,
    ).toBe('九月十五日');
  });

  it('does not join natural new segments, other providers or unrelated segment ids', () => {
    for (const segment of [
      { ...previous, segmentId: 'tail', status: 'partial' as const },
      { ...tail, provider: 'gemini-live' },
      { ...tail, continuationOf: 'unrelated' },
    ]) {
      expect(
        computeDisplayed(segment, previous, tx('tail', '日'), tx('before', '九月十五'))?.target,
      ).toBe('日');
    }
  });

  it('keeps negation attached across a storage boundary without changing stored wording', () => {
    const beforeTranslation = tx('before', '我們不會');
    const tailTranslation = tx('tail', '取消這個項目');
    expect(computeDisplayed(tail, previous, tailTranslation, beforeTranslation)?.target).toBe(
      '我們不會取消這個項目',
    );
    expect(beforeTranslation.targetText).toBe('我們不會');
    expect(tailTranslation.targetText).toBe('取消這個項目');
  });

  it('bounds displayed context and never follows the predecessor continuation recursively', () => {
    const context = { ...previous, continuationOf: 'older' };
    const result = computeDisplayed(
      tail,
      context,
      tx('tail', '日'),
      tx('before', '字'.repeat(500)),
    );
    expect(result?.target).toBe('字'.repeat(159) + '日');
    expect(result?.target.length).toBe(160);
  });

  it('keeps the current source and target visible when the predecessor was evicted', () => {
    expect(computeDisplayed(tail, undefined, tx('tail', '日'), undefined)).toMatchObject({
      target: '日',
      status: 'partial',
    });
  });
});
