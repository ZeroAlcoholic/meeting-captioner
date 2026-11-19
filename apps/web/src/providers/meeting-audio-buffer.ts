const CAPACITY_SAMPLES = 60 * 16_000;

export interface SampleRange {
  trackId: string;
  captureEpoch: string;
  from: number;
  to: number;
}
export interface AudioFrame {
  trackId: string;
  captureEpoch: string;
  startSample: number;
  sampleRate: 16000;
  pcm: Float32Array;
}
export interface BufferRead {
  frames: AudioFrame[];
  missing: SampleRange[];
}

/** One capture epoch, fixed 60s maximum allocation; no clock or provider ownership. */
export class MeetingAudioBuffer {
  private readonly pcm: Float32Array;
  private identity: Pick<SampleRange, 'trackId' | 'captureEpoch'> | null = null;
  private from = 0;
  private to = 0;

  constructor(capacitySamples = CAPACITY_SAMPLES) {
    if (
      !Number.isSafeInteger(capacitySamples) ||
      capacitySamples < 1 ||
      capacitySamples > CAPACITY_SAMPLES
    )
      throw new RangeError('PCM retention capacity must be between 1 sample and 60 seconds');
    this.pcm = new Float32Array(capacitySamples);
  }

  get byteLength(): number {
    return this.pcm.byteLength;
  }
  get retainedRange(): SampleRange | null {
    return this.identity ? { ...this.identity, from: this.from, to: this.to } : null;
  }

  append(frame: AudioFrame): SampleRange[] {
    const end = frame.startSample + frame.pcm.length;
    if (
      !Number.isSafeInteger(frame.startSample) ||
      frame.startSample < 0 ||
      !Number.isSafeInteger(end) ||
      frame.sampleRate !== 16000 ||
      !frame.trackId ||
      !frame.captureEpoch
    )
      throw new RangeError('Invalid capture frame');
    if (
      this.identity &&
      (frame.trackId !== this.identity.trackId ||
        frame.captureEpoch !== this.identity.captureEpoch ||
        frame.startSample !== this.to)
    )
      throw new Error('Capture frames must be contiguous within one track and epoch');
    if (!frame.pcm.length) return [];
    if (!this.identity) {
      this.identity = { trackId: frame.trackId, captureEpoch: frame.captureEpoch };
      this.from = this.to = frame.startSample;
    }
    const previousFrom = this.from;
    const offset = Math.max(0, frame.pcm.length - this.pcm.length);
    const input = frame.pcm.subarray(offset);
    const position = (frame.startSample + offset) % this.pcm.length;
    const first = Math.min(input.length, this.pcm.length - position);
    this.pcm.set(input.subarray(0, first), position);
    this.pcm.set(input.subarray(first), 0);
    this.to = end;
    this.from = Math.max(previousFrom, end - this.pcm.length);
    return this.from > previousFrom
      ? [{ ...this.identity, from: previousFrom, to: this.from }]
      : [];
  }

  read(range: SampleRange): BufferRead {
    if (
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < 0 ||
      range.to < range.from
    )
      throw new RangeError('Invalid sample range');
    if (range.from === range.to) return { frames: [], missing: [] };
    const from = Math.max(range.from, this.from);
    const to = Math.min(range.to, this.to);
    if (
      !this.identity ||
      range.trackId !== this.identity.trackId ||
      range.captureEpoch !== this.identity.captureEpoch ||
      from >= to
    )
      return { frames: [], missing: [{ ...range }] };
    const missing: SampleRange[] = [];
    if (range.from < from) missing.push({ ...range, to: from });
    if (range.to > to) missing.push({ ...range, from: to });
    // Return a copy bounded by capacity, never a view into the capture buffer.
    const pcm = new Float32Array(to - from);
    const position = from % this.pcm.length;
    const first = Math.min(pcm.length, this.pcm.length - position);
    pcm.set(this.pcm.subarray(position, position + first));
    pcm.set(this.pcm.subarray(0, pcm.length - first), first);
    return { frames: [{ ...this.identity, startSample: from, sampleRate: 16000, pcm }], missing };
  }

  clear(): void {
    this.pcm.fill(0);
    this.identity = null;
    this.from = this.to = 0;
  }
}
