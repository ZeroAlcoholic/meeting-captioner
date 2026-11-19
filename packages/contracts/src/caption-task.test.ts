import { describe, expect, it } from 'vitest';
import { CaptionTask } from './index.js';

describe('CaptionTask', () => {
  const transcription = {
    purpose: 'transcription',
    inputLanguages: ['zh-tw', 'en'],
    textPolicy: 'zh-TW-preserve-original',
  };

  it('exports a strict purpose schema', () => {
    expect(CaptionTask).toBeDefined();
  });

  it('accepts bilingual and single-language transcription', () => {
    expect(CaptionTask.parse(transcription)).toEqual(transcription);
    expect(CaptionTask.safeParse({ ...transcription, inputLanguages: ['en'] }).success).toBe(true);
  });

  it.each(['en→zh-TW', 'zh-TW→en'])('preserves translation direction %s', (langPair) => {
    const task = { purpose: 'translation', langPair };
    expect(CaptionTask.parse(task)).toEqual(task);
  });

  it.each([
    { inputLanguages: [] },
    { inputLanguages: ['ja'] },
    { inputLanguages: ['zh-tw', 'en', 'en'] },
  ])('rejects invalid input languages $inputLanguages', ({ inputLanguages }) => {
    expect(CaptionTask.safeParse({ ...transcription, inputLanguages }).success).toBe(false);
  });

  it('rejects fields from the other purpose and arbitrary extra properties', () => {
    expect(CaptionTask.safeParse({ ...transcription, langPair: 'en→zh-TW' }).success).toBe(false);
    expect(CaptionTask.safeParse({ ...transcription, model: 'custom' }).success).toBe(false);
    expect(
      CaptionTask.safeParse({
        purpose: 'translation',
        langPair: 'en→zh-TW',
        inputLanguages: ['en'],
      }).success,
    ).toBe(false);
  });
});
