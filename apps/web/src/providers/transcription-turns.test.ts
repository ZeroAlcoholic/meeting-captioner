import { beforeAll, describe, expect, it } from 'vitest';
import { TranscriptionTurns } from './transcription-turns.js';
import { loadTranscriptNormalizer } from './transcript-normalization.js';

describe('transcription turn ordering', () => {
  // Publishing a turn normalizes its text; providers load the dictionary while
  // they connect, so a direct unit test has to load it too.
  beforeAll(() => loadTranscriptNormalizer());

  it('publishes contiguous input provenance only after committed item completion', () => {
    const events: import('@meeting-audio/contracts').TranscriptEvent[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (event) => events.push(event));
    const range = { trackId: 'mic', captureEpoch: 'capture-1', from: 512, to: 1024 };
    turns.acceptAudio(0, 32, false, range);
    turns.acceptAudio(32, 64, false, { ...range, from: 1024, to: 1536 });
    turns.submit(0, 64);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'hello',
    });
    expect(events).toHaveLength(0);
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    expect(events[0]).toMatchObject({
      status: 'final',
      inputAudioRange: { ...range, to: 1536, sampleRate: 16000 },
    });
  });

  it.each([
    undefined,
    { trackId: 'mic', captureEpoch: 'other', from: 512, to: 1024 },
    { trackId: 'mic', captureEpoch: 'capture-1', from: 513, to: 1025 },
  ])('does not repair unknown or discontinuous input provenance by guessing (%j)', (middle) => {
    const events: import('@meeting-audio/contracts').TranscriptEvent[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (event) => events.push(event));
    const range = { trackId: 'mic', captureEpoch: 'capture-1', from: 0, to: 512 };
    turns.acceptAudio(0, 32, false, range);
    turns.acceptAudio(32, 64, false, middle);
    turns.acceptAudio(64, 96, false, { ...range, from: 1024, to: 1536 });
    turns.submit(0, 96);
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'hello',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('inputAudioRange');
  });

  it('holds early finals until committed order and preserves identical separate utterances', () => {
    const events: { text: string; status: string; startMs: number }[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (e) => events.push(e));
    turns.submit(1000, 2000);
    turns.submit(2000, 3000);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      content_index: 0,
      transcript: 'yes',
    });
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'b', previous_item_id: 'a' });
    expect(events).toHaveLength(0);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      content_index: 0,
      transcript: 'yes',
    });
    expect(events.map((e) => e.startMs)).toEqual([1000, 2000]);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      content_index: 0,
      transcript: 'yes',
    });
    expect(events).toHaveLength(2);
    expect(turns.pending).toBe(0);
  });
  it('retains unfinished partial and rejects bounded queue overflow', () => {
    const turns = new TranscriptionTurns('test', 'microphone', () => {});
    for (let i = 0; i < 64; i++) turns.submit(i, i + 1);
    expect(() => turns.submit(65, 66)).toThrow(/pending/);
    expect(turns.pending).toBe(64);
  });
  it('deduplicates transport events but preserves literal repeated words and final corrections', () => {
    const events: { text: string; status: string }[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (e) => events.push(e));
    turns.submit(0, 100);
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    const delta = {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      event_id: 'delta-1',
      content_index: 0,
      delta: 'yes yes',
    };
    turns.receive(delta);
    turns.receive(delta);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      content_index: 0,
      transcript: 'Yes, yes.',
    });
    expect(events.map((e) => [e.status, e.text])).toEqual([
      ['partial', 'yes yes'],
      ['final', 'Yes, yes.'],
    ]);
  });
  it('rejects inconsistent commit predecessor instead of silently misassigning times', () => {
    const turns = new TranscriptionTurns('test', 'microphone', () => {});
    turns.submit(0, 100);
    expect(() =>
      turns.receive({
        type: 'input_audio_buffer.committed',
        item_id: 'a',
        previous_item_id: 'unknown',
      }),
    ).toThrow(/order/);
  });
  it('bounds early transcript payloads before commit acknowledgement', () => {
    const turns = new TranscriptionTurns('test', 'microphone', () => {});
    expect(() =>
      turns.receive({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'a',
        delta: 'x'.repeat(100001),
      }),
    ).toThrow(/limit/);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'x'.repeat(100000),
    });
    expect(() =>
      turns.receive({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'a',
        delta: 'x',
      }),
    ).toThrow(/limit/);
  });
  it('releases the next buffered partial when its predecessor becomes final', () => {
    const events: { text: string; status: string }[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (e) => events.push(e));
    turns.submit(0, 100);
    turns.submit(100, 200);
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'b', previous_item_id: 'a' });
    turns.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'b',
      delta: 'B',
    });
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'A',
    });
    expect(events.map((e) => [e.status, e.text])).toEqual([
      ['final', 'A'],
      ['partial', 'B'],
    ]);
  });
  it('renders streaming partial before commit with sample-clock timing and stable identity', () => {
    const events: { text: string; status: string; segmentId: string; startMs: number }[] = [];
    const turns = new TranscriptionTurns('test', 'microphone', (e) => events.push(e));
    turns.acceptAudio(1000, 1032, false);
    turns.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: '不是',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.startMs).toBe(1000);
    turns.acceptAudio(1032, 1064, false);
    turns.submit(1000, 1064);
    turns.receive({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
    turns.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: '不是 approve',
    });
    expect(events.map((e) => e.status)).toEqual(['partial', 'final']);
    expect(events[0]?.segmentId).toBe(events[1]?.segmentId);
  });
  it('rejects malformed recognized events instead of silently losing a turn', () => {
    const turns = new TranscriptionTurns('test', 'microphone', () => {});
    expect(() => turns.receive({ type: 'input_audio_buffer.committed' })).toThrow(/Malformed/);
    expect(() =>
      turns.receive({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'a',
      }),
    ).toThrow(/Malformed/);
  });
});
