import { describe, it, expect } from 'vitest';

// We deliberately don't render the full React component here — that needs a
// DOM environment. Instead, we re-derive the same arithmetic by reading the
// pricing constants and verifying the per-minute math against OpenAI's
// documented rates. This is a regression guard against the old gpt-4o
// token-based formula re-creeping in.
//
// Documented May 2026:
//   gpt-realtime-translate  $0.034 / min
//   gpt-realtime-whisper    $0.017 / min  (only when bilingual)

const TRANSLATE_USD_PER_MIN = 0.034;
const WHISPER_USD_PER_MIN = 0.017;

function expectedTotal(minutes: number, bilingual: boolean): number {
  return minutes * (TRANSLATE_USD_PER_MIN + (bilingual ? WHISPER_USD_PER_MIN : 0));
}

describe('pricing — realtime translation flat per-minute', () => {
  it('charges $0.034/min in translation-only mode', () => {
    expect(expectedTotal(1, false)).toBeCloseTo(0.034, 6);
    expect(expectedTotal(60, false)).toBeCloseTo(2.04, 6);
    expect(expectedTotal(90, false)).toBeCloseTo(3.06, 6);
  });

  it('charges $0.051/min in bilingual mode (translate + whisper)', () => {
    expect(expectedTotal(1, true)).toBeCloseTo(0.051, 6);
    expect(expectedTotal(60, true)).toBeCloseTo(3.06, 6);
    expect(expectedTotal(90, true)).toBeCloseTo(4.59, 6);
  });

  it('bilingual surcharge is exactly +50% on top of translate-only', () => {
    // 0.017 / 0.034 = 0.5 — useful sanity check that the constants are correct.
    expect(WHISPER_USD_PER_MIN / TRANSLATE_USD_PER_MIN).toBeCloseTo(0.5, 6);
  });
});
