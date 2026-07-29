import { describe, expect, it } from 'vitest';
import { GEMINI_LIVE_USD_PER_MIN_EST } from './GeminiPricingPanel.js';

// Regression guard for the speed-first Gemini Live Translate path. The provider
// requests AUDIO output, so the estimate must include both input audio and
// generated output audio, even though the app discards playback.
const GEMINI_LIVE_AUDIO_INPUT_USD_PER_MIN = 0.0053;
const GEMINI_LIVE_AUDIO_OUTPUT_USD_PER_MIN = 0.0315;

describe('pricing — Gemini Live Translate AUDIO mode estimate', () => {
  it('includes generated output audio, not only input audio', () => {
    expect(GEMINI_LIVE_USD_PER_MIN_EST).toBeCloseTo(
      GEMINI_LIVE_AUDIO_INPUT_USD_PER_MIN + GEMINI_LIVE_AUDIO_OUTPUT_USD_PER_MIN,
      6,
    );
    expect(GEMINI_LIVE_USD_PER_MIN_EST).toBeGreaterThan(0.034);
  });

  it('estimates hourly cost from the AUDIO-mode rate', () => {
    expect(60 * GEMINI_LIVE_USD_PER_MIN_EST).toBeCloseTo(2.208, 6);
  });
});
