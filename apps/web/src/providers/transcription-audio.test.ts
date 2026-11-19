import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIPTION_GATE_POLICY,
  TranscriptionSpeechGate,
} from './transcription-audio.js';
describe('Silero probability speech policy', () => {
  it('documents the shipped endpointing thresholds', () => {
    expect(DEFAULT_TRANSCRIPTION_GATE_POLICY).toEqual({
      lookBehindMs: 800,
      silenceTailMs: 700,
      maxUtteranceMs: 30_000,
    });
  });
  it('commits on the injected silence tail instead of the default one', () => {
    const commits: number[][] = [];
    const gate = new TranscriptionSpeechGate(
      () => {},
      (a, b) => commits.push([a, b]),
      { silenceTailMs: 200 },
    );
    const frame = new Float32Array(512);
    gate.push(frame, 0.9, 0);
    for (let i = 1; i < 10; i++) gate.push(frame, 0, i * 32);
    // 200 ms of quiet ends the turn; the default would still be waiting.
    expect(commits).toEqual([[0, 256]]);
  });
  it('splits a monologue on the injected hard bound, marking the continuation', () => {
    const commits: boolean[] = [];
    const gate = new TranscriptionSpeechGate(
      () => {},
      (_a, _b, continuing) => commits.push(continuing),
      { maxUtteranceMs: 1_000 },
    );
    for (let i = 0; i < 100; i++) gate.push(new Float32Array(512), 0.9, i * 32);
    gate.flush();
    expect(commits).toEqual([false, true, true, true]);
  });
  it('keeps only the injected look-behind before speech starts', () => {
    let appends = 0;
    const gate = new TranscriptionSpeechGate(
      () => appends++,
      () => {},
      { lookBehindMs: 96 },
    );
    const frame = new Float32Array(512);
    for (let i = 0; i < 50; i++) gate.push(frame, 0, i * 32);
    gate.push(frame, 0.9, 1600);
    // 96 ms of look-behind is three 32 ms frames, the opening one included.
    expect(appends).toBe(3);
  });

  it('anchors the utterance on the arriving frame when the look-behind is shorter than one', () => {
    const starts: number[] = [];
    const gate = new TranscriptionSpeechGate(
      (_frame, startMs) => starts.push(startMs),
      () => {},
      { lookBehindMs: 0 },
    );
    const frame = new Float32Array(512);
    for (let i = 0; i < 10; i++) gate.push(frame, 0, i * 32);
    gate.push(frame, 0.9, 320);
    // A parameter sweep will try 0. Trimming the frame that just arrived would
    // leave nothing to anchor the start on and throw inside the audio callback,
    // which stops captions for the rest of the meeting.
    expect(starts).toEqual([320]);
  });

  it('keeps a single-frame utterance, preroll and tail; silence creates no turn', () => {
    let appends = 0;
    const commits: number[][] = [];
    const gate = new TranscriptionSpeechGate(
      () => appends++,
      (a, b) => commits.push([a, b]),
    );
    const frame = new Float32Array(512);
    for (let i = 0; i < 100; i++) gate.push(frame, 0, i * 32);
    expect(appends).toBe(0);
    gate.push(frame, 0.9, 3200);
    for (let i = 101; i < 123; i++) gate.push(frame, 0, i * 32);
    expect(appends).toBe(47);
    expect(commits).toEqual([[2432, 3936]]);
  });
  it('bounds 60-second speech turns without losing frames or continuation', () => {
    let appends = 0;
    const commits: boolean[] = [];
    const gate = new TranscriptionSpeechGate(
      () => appends++,
      (_a, _b, c) => commits.push(c),
    );
    for (let i = 0; i < 1875; i++) gate.push(new Float32Array(512), 0.9, i * 32);
    gate.flush();
    expect(appends).toBe(1875);
    expect(commits).toEqual([false, true]);
  });
  it('does not commit an empty continuation when stopped exactly at the hard boundary', () => {
    const commits: number[] = [];
    const gate = new TranscriptionSpeechGate(
      () => {},
      (a, b) => commits.push(b - a),
    );
    for (let i = 0; i < 938; i++) gate.push(new Float32Array(512), 0.9, i * 32);
    gate.flush();
    expect(commits).toEqual([30016]);
  });
});
