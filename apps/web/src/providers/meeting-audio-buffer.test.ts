import { describe, expect, it } from 'vitest';
import { MeetingAudioBuffer, type AudioFrame } from './meeting-audio-buffer.js';

const frame = (startSample: number, pcm: number[], captureEpoch = 'e1'): AudioFrame => ({
  trackId: 'mic',
  captureEpoch,
  startSample,
  sampleRate: 16000,
  pcm: Float32Array.from(pcm),
});
const range = (from: number, to: number, captureEpoch = 'e1') => ({
  trackId: 'mic',
  captureEpoch,
  from,
  to,
});

describe('capture-owned bounded PCM retention', () => {
  it('returns exact overwritten and missing ranges across a wrap', () => {
    const ring = new MeetingAudioBuffer(8);
    ring.append(frame(0, [0, 1, 2, 3, 4, 5]));
    expect(ring.append(frame(6, [6, 7, 8, 9, 10, 11]))).toEqual([range(0, 4)]);
    const result = ring.read(range(0, 14));
    expect(result.missing).toEqual([range(0, 4), range(12, 14)]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.startSample).toBe(4);
    expect(Array.from(result.frames[0]!.pcm)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ring.byteLength).toBe(32);
  });
  it('handles frames larger than capacity and does not retain caller memory', () => {
    const ring = new MeetingAudioBuffer(3);
    const input = frame(0, [0, 1, 2, 3, 4]);
    expect(ring.append(input)).toEqual([range(0, 2)]);
    input.pcm.fill(99);
    const output = ring.read(range(0, 5));
    expect(Array.from(output.frames[0]!.pcm)).toEqual([2, 3, 4]);
    output.frames[0]!.pcm.fill(88);
    expect(Array.from(ring.read(range(2, 5)).frames[0]!.pcm)).toEqual([2, 3, 4]);
  });
  it('does not mix epochs, tracks or discontinuous sample clocks', () => {
    const ring = new MeetingAudioBuffer(8);
    ring.append(frame(0, [1, 2]));
    expect(() => ring.append(frame(2, [3], 'e2'))).toThrow();
    expect(() => ring.append({ ...frame(2, [3]), trackId: 'remote' })).toThrow();
    expect(() => ring.append(frame(3, [3]))).toThrow();
    expect(ring.read(range(0, 2, 'e2'))).toEqual({ frames: [], missing: [range(0, 2, 'e2')] });
    expect(Array.from(ring.read(range(0, 2)).frames[0]!.pcm)).toEqual([1, 2]);
  });
  it('clears audio and identity on Stop and does not synthesize sleep samples', () => {
    const ring = new MeetingAudioBuffer(8);
    ring.append(frame(0, [1, 2]));
    // Wall-clock passage cannot alter sample position without a captured frame.
    expect(ring.retainedRange).toEqual(range(0, 2));
    ring.clear();
    expect(ring.retainedRange).toBeNull();
    expect(ring.read(range(0, 2))).toEqual({ frames: [], missing: [range(0, 2)] });
    ring.append(frame(0, [7], 'e2'));
    expect(Array.from(ring.read(range(0, 1, 'e2')).frames[0]!.pcm)).toEqual([7]);
    expect(ring.byteLength).toBe(32);
  });
  it.each([3, 10, 30, 90])(
    'retains exact counter samples after %i seconds with a 60s cap',
    (seconds) => {
      const ring = new MeetingAudioBuffer();
      let position = 0;
      while (position < seconds * 16000) {
        const size = Math.min(733, seconds * 16000 - position);
        ring.append(
          frame(
            position,
            Array.from({ length: size }, (_, i) => position + i),
          ),
        );
        position += size;
      }
      const from = Math.max(0, position - 60 * 16000);
      const result = ring.read(range(0, position));
      expect(result.missing).toEqual(from ? [range(0, from)] : []);
      const samples = result.frames[0]!.pcm;
      expect(samples.length).toBe(position - from);
      for (let i = 0; i < samples.length; i++)
        if (samples[i] !== from + i) throw new Error(`Sample mismatch ${i}`);
      expect(ring.byteLength).toBe(3_840_000);
    },
  );
  it('rejects invalid capacity/ranges without allocating unbounded reads', () => {
    expect(() => new MeetingAudioBuffer(0)).toThrow();
    const ring = new MeetingAudioBuffer(8);
    expect(() => ring.append(frame(-1, [1]))).toThrow();
    expect(() => ring.read(range(2, 1))).toThrow();
    expect(ring.read(range(1, 1))).toEqual({ frames: [], missing: [] });
  });
});
