import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('PCM worklet bounded tail flush', () => {
  it('timestamps actual PCM on the shared audio clock, including chunk boundaries, gaps and tails', () => {
    const posted: Array<{ type: string; startFrame?: number; pcm?: ArrayBuffer }> = [];
    class Base {
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (data: (typeof posted)[number]) => posted.push(data),
      };
    }
    type Processor = Base & { process(inputs: Float32Array[][]): boolean };
    let create!: new (options: object) => Processor;
    const clock = {
      currentFrame: 1000,
      Float32Array,
      AudioWorkletProcessor: Base,
      registerProcessor: (_name: string, ctor: typeof create) => {
        create = ctor;
      },
    };
    runInNewContext(
      readFileSync(new URL('../../public/pcm-worklet.js', import.meta.url), 'utf8'),
      clock,
    );
    const processor = new create({ processorOptions: { chunkSize: 4, frameMetadata: true } });
    processor.process([[new Float32Array([1, 2, 3])]]);
    clock.currentFrame = 1003;
    processor.process([[new Float32Array([4, 5, 6])]]);
    // A missing input interval must not be presented as contiguous captured PCM.
    clock.currentFrame = 1100;
    processor.process([[]]);
    processor.process([[new Float32Array([7, 8, 9])]]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(
      posted.map(({ type, startFrame, pcm }) => ({
        type,
        startFrame,
        samples: pcm ? Array.from(new Float32Array(pcm)) : undefined,
      })),
    ).toEqual([
      { type: 'pcm', startFrame: 1000, samples: [1, 2, 3, 4] },
      { type: 'pcm', startFrame: 1004, samples: [5, 6] },
      { type: 'pcm', startFrame: 1100, samples: [7, 8, 9] },
      { type: 'flushed', startFrame: undefined, samples: undefined },
    ]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(posted.filter((entry) => entry.type === 'pcm')).toHaveLength(3);
  });
  it('counter-only WebRTC capture probe reports samples including silence without PCM buffers', () => {
    const posted: unknown[] = [];
    class Base {
      port = { onmessage: null, postMessage: (data: unknown) => posted.push(data) };
    }
    type Processor = Base & { process(inputs: Float32Array[][]): boolean };
    let create!: new (options: object) => Processor;
    const code = readFileSync(new URL('../../public/pcm-worklet.js', import.meta.url), 'utf8');
    new Function('AudioWorkletProcessor', 'registerProcessor', code)(
      Base,
      (_name: string, ctor: typeof create) => {
        create = ctor;
      },
    );
    const processor = new create({ processorOptions: { chunkSize: 512, progressOnly: true } });
    for (let i = 0; i < 4; i++) processor.process([[new Float32Array(128)]]);
    expect(posted).toEqual([{ type: 'capture_progress', samples: 512 }]);
    processor.process([[]]);
    expect(posted).toHaveLength(1);
  });
  it('returns residual samples before flush acknowledgement and does not repeat them', () => {
    const posted: unknown[] = [];
    class Base {
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (data: unknown) => posted.push(data),
      };
    }
    type Processor = Base & { process: (inputs: Float32Array[][]) => boolean };
    let create!: new (options: object) => Processor;
    const code = readFileSync(new URL('../../public/pcm-worklet.js', import.meta.url), 'utf8');
    new Function('AudioWorkletProcessor', 'registerProcessor', code)(
      Base,
      (_name: string, ctor: typeof create) => {
        create = ctor;
      },
    );
    const processor = new create({ processorOptions: { chunkSize: 512 } });
    processor.process([[new Float32Array([0.1, 0.2, 0.3])]]);
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(posted).toHaveLength(2);
    expect(Array.from(new Float32Array(posted[0] as ArrayBuffer))).toEqual(
      Array.from(new Float32Array([0.1, 0.2, 0.3])),
    );
    expect(posted[1]).toEqual({ type: 'flushed' });
    processor.port.onmessage?.({ data: { type: 'flush' } });
    expect(posted).toHaveLength(3);
  });
});
