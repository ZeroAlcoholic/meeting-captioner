import type { AudioSourceKind, TranscriptEvent } from '@meeting-audio/contracts';
import { normalizeTranscript } from './transcript-normalization.js';
import type { SampleRange } from './meeting-audio-buffer.js';

export interface TranscriptionWireEvent {
  type: string;
  item_id?: string;
  previous_item_id?: string | null;
  content_index?: number;
  event_id?: string;
  delta?: string;
  transcript?: string;
}
interface Turn {
  segmentId: string;
  startMs: number;
  endMs: number;
  continuationOf?: string;
  itemId?: string;
  text: string;
  final: boolean;
  submitted: boolean;
  acknowledged: boolean;
  publishedText?: string;
  inputAudioRange: SampleRange | null;
}

/** One instance per socket generation. Timings originate in the capture sample clock. */
export class TranscriptionTurns {
  private readonly turns: Turn[] = [];
  private readonly early = new Map<string, TranscriptionWireEvent[]>();
  private readonly completed = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private lastItem: string | null = null;
  private lastSegment: string | undefined;
  private sequence = 0;
  private live: Turn | undefined;
  constructor(
    private readonly generation: string,
    private readonly source: AudioSourceKind,
    private readonly emit: (event: TranscriptEvent) => void,
  ) {}
  get pending(): number {
    return this.turns.length;
  }
  acceptAudio(
    startMs: number,
    endMs: number,
    continuation: boolean,
    range?: SampleRange | null,
  ): void {
    if (!this.live) {
      this.live = this.create(startMs, endMs, continuation);
      this.live.inputAudioRange = range ? { ...range } : null;
    } else {
      const previous = this.live.inputAudioRange;
      this.live.inputAudioRange =
        previous &&
        range &&
        previous.trackId === range.trackId &&
        previous.captureEpoch === range.captureEpoch &&
        previous.to === range.from
          ? { ...previous, to: range.to }
          : null;
    }
    this.live.endMs = Math.round(endMs);
  }
  submit(startMs: number, endMs: number, continuation = false): void {
    const turn = this.live ?? this.create(startMs, endMs, continuation);
    turn.endMs = Math.round(endMs);
    turn.submitted = true;
    this.live = undefined;
  }
  private create(startMs: number, endMs: number, continuation: boolean): Turn {
    if (this.turns.length >= 64) throw new Error('Too many pending transcription turns; audio gap');
    const segmentId = `${this.generation}:${++this.sequence}`;
    const turn: Turn = {
      segmentId,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      ...(continuation && this.lastSegment ? { continuationOf: this.lastSegment } : {}),
      text: '',
      final: false,
      submitted: false,
      acknowledged: false,
      inputAudioRange: null,
    };
    this.turns.push(turn);
    this.lastSegment = segmentId;
    return turn;
  }
  receive(event: TranscriptionWireEvent): void {
    const recognized =
      event.type === 'input_audio_buffer.committed' ||
      event.type.startsWith('conversation.item.input_audio_transcription.');
    if (
      recognized &&
      (typeof event.item_id !== 'string' ||
        !event.item_id ||
        (event.type.endsWith('.delta') && typeof event.delta !== 'string') ||
        (event.type.endsWith('.completed') && typeof event.transcript !== 'string'))
    )
      throw new Error('Malformed transcription event');
    if ((event.delta?.length ?? 0) > 100_000 || (event.transcript?.length ?? 0) > 100_000)
      throw new Error('Transcription text limit exceeded');
    if (event.event_id) {
      if (this.seenEvents.has(event.event_id)) return;
      this.seenEvents.add(event.event_id);
      if (this.seenEvents.size > 2048)
        this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const id = event.item_id;
    if (!id || this.completed.has(id)) return;
    if (event.type === 'input_audio_buffer.committed') {
      if (this.turns.some((t) => t.itemId === id && t.acknowledged)) return;
      const turn = this.turns.find((t) => t.submitted && !t.acknowledged);
      if (!turn) throw new Error('Unexpected transcription commit acknowledgement');
      if (turn.itemId && turn.itemId !== id)
        throw new Error('Transcription live item order mismatch');
      if (event.previous_item_id !== undefined && event.previous_item_id !== this.lastItem)
        throw new Error('Transcription commit order mismatch');
      turn.itemId = id;
      turn.acknowledged = true;
      this.lastItem = id;
      const pending = this.early.get(id) ?? [];
      this.early.delete(id);
      for (const queued of pending) this.apply(turn, queued);
      this.flush();
      return;
    }
    if (!event.type.startsWith('conversation.item.input_audio_transcription.')) return;
    if (event.content_index !== undefined && event.content_index !== 0)
      throw new Error('Unexpected transcription content index');
    let turn = this.turns.find((t) => t.itemId === id);
    // Live model deltas can precede manual commit. Only bind when no earlier
    // unacknowledged submitted item could own this ID; ambiguous events wait.
    if (
      !turn &&
      event.type.endsWith('.delta') &&
      this.live &&
      !this.live.itemId &&
      !this.turns.some((t) => t.submitted && !t.acknowledged)
    ) {
      turn = this.live;
      turn.itemId = id;
    }
    if (!turn) {
      const queued = this.early.get(id) ?? [];
      const queuedCharacters = queued.reduce(
        (sum, item) => sum + (item.delta?.length ?? item.transcript?.length ?? 0),
        0,
      );
      if (queuedCharacters + (event.delta?.length ?? event.transcript?.length ?? 0) > 100_000)
        throw new Error('Transcription text limit exceeded');
      if (this.early.size >= 64 || queued.length >= 256)
        throw new Error('Transcription event buffer overflow');
      queued.push(event);
      this.early.set(id, queued);
      return;
    }
    this.apply(turn, event);
    this.flush();
  }
  private apply(turn: Turn, event: TranscriptionWireEvent): void {
    if (turn.final) return;
    if (event.type.endsWith('.failed'))
      throw new Error('Transcription failed; unfinished audio remains');
    if (event.type.endsWith('.delta') && typeof event.delta === 'string') turn.text += event.delta;
    if (event.type.endsWith('.completed') && typeof event.transcript === 'string') {
      turn.text = event.transcript;
      turn.final = true;
    }
    if (turn.text.length > 100_000) throw new Error('Transcription text limit exceeded');
    if (this.turns[0] === turn && !turn.final && turn.text) this.publish(turn, 'partial');
  }
  private flush(): void {
    while (this.turns[0]?.final && this.turns[0].acknowledged) {
      const turn = this.turns.shift()!;
      this.publish(turn, 'final');
      this.completed.add(turn.itemId!);
      if (this.completed.size > 2048) this.completed.delete(this.completed.values().next().value!);
    }
    const head = this.turns[0];
    if (head?.text && !head.final && head.text !== head.publishedText)
      this.publish(head, 'partial');
  }
  private publish(turn: Turn, status: 'partial' | 'final'): void {
    turn.publishedText = turn.text;
    this.emit({
      kind: 'transcript',
      provider: 'openai-transcription',
      mode: 'online_full',
      source: this.source,
      segmentId: turn.segmentId,
      status,
      ...normalizeTranscript(turn.text),
      timingBasis: 'capture-estimated',
      startMs: turn.startMs,
      ...(status === 'final' ? { endMs: turn.endMs } : {}),
      ...(status === 'final' && turn.inputAudioRange
        ? { inputAudioRange: { ...turn.inputAudioRange, sampleRate: 16000 as const } }
        : {}),
      ...(turn.continuationOf ? { continuationOf: turn.continuationOf } : {}),
    });
  }
}
