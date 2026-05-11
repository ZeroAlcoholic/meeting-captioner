import { describe, expect, it } from 'vitest';
import { rmsToWidthPercent } from './AudioLevelMeter.js';

describe('rmsToWidthPercent', () => {
  it('maps -60 dB (floor) to 0%', () => {
    expect(rmsToWidthPercent(-60)).toBe(0);
  });

  it('maps 0 dB (ceiling) to 100%', () => {
    expect(rmsToWidthPercent(0)).toBe(100);
  });

  it('maps -30 dB (midpoint) to 50%', () => {
    expect(rmsToWidthPercent(-30)).toBe(50);
  });

  it('clamps values below -60 dB to 0%', () => {
    expect(rmsToWidthPercent(-100)).toBe(0);
  });

  it('clamps values above 0 dB to 100%', () => {
    expect(rmsToWidthPercent(10)).toBe(100);
  });

  it('is monotonic — louder rms produces wider bar', () => {
    const widths = [-60, -45, -30, -15, 0].map(rmsToWidthPercent);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1] ?? -1);
    }
  });
});
