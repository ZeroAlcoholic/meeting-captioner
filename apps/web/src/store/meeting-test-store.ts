import type { MeetingEnvelope, MeetingMetadata } from '@meeting-audio/contracts';
import type {
  DurableMeetingStore,
  PendingEnvelope,
  StorageLossGap,
  RestoreIntent,
} from './meeting-outbox.js';

export class MemoryMeetingStore implements DurableMeetingStore {
  restoreIntent: RestoreIntent | null = null;
  async readRestoreIntent() {
    return this.restoreIntent;
  }
  async clearRestoreIntent(generation: string) {
    if (this.restoreIntent?.generation !== generation)
      throw new Error('ARCHIVE_RESTORE_SUPERSEDED');
    this.restoreIntent = null;
  }
  async saveRestoreIntent(intent: RestoreIntent) {
    if (this.restoreIntent) throw new Error('ARCHIVE_RESTORE_PENDING');
    this.restoreIntent = structuredClone(intent);
  }
  retiredLosses = new Map<string, StorageLossGap>();
  retiredRecords = new Map<string, unknown>();
  async exportRetired() {
    return new Blob(
      [...this.retiredRecords].map(([key, value]) => JSON.stringify({ key, value }) + '\n'),
      { type: 'application/x-ndjson' },
    );
  }
  async retireForRestore(generation: string, preservePending = false) {
    if (this.events.length && !preservePending) throw new Error('ARCHIVE_PENDING_DATA');
    if (this.fail) throw new Error('quota');
    const prefix = `retired:${this.generation ?? 'legacy'}:`;
    if (preservePending) {
      for (const event of this.events)
        this.retiredRecords.set(prefix + 'event:' + event.eventId, structuredClone(event));
      for (const meeting of this.meetings)
        this.retiredRecords.set(prefix + 'meeting:' + meeting.meetingId, structuredClone(meeting));
      this.events = [];
    }
    for (const [key, value] of this.losses) this.retiredLosses.set(key, value);
    for (const value of this.losses.values())
      this.retiredRecords.set(
        prefix + `loss:${value.meetingId}:${value.gapId}`,
        structuredClone(value),
      );
    this.losses.clear();
    this.meetings = [];
    this.revisions.clear();
    this.generation = generation;
    this.restoreIntent = null;
  }
  generation: string | null = null;
  async bindArchiveGeneration(generation: string | null) {
    if (
      generation !== this.generation &&
      (this.events.length || this.meetings.length || this.revisions.size || this.losses.size)
    )
      throw new Error('ARCHIVE_GENERATION_MISMATCH');
    this.generation = generation;
  }
  losses = new Map<string, StorageLossGap>();
  async saveLoss(gap: StorageLossGap) {
    if (this.fail) throw new Error('quota');
    this.losses.set(gap.gapId, structuredClone(gap));
  }
  async readLosses(meetingId: string) {
    return [...this.losses.values()].filter((gap) => gap.meetingId === meetingId);
  }
  events: MeetingEnvelope[] = [];
  meetings: MeetingMetadata[] = [];
  revisions = new Map<string, number>();
  fail = false;
  async getWriterId() {
    return '11111111-1111-4111-8111-111111111111';
  }
  async saveMeeting(meeting: MeetingMetadata) {
    this.meetings = [...this.meetings.filter((m) => m.meetingId !== meeting.meetingId), meeting];
  }
  async listMeetings() {
    return this.meetings;
  }
  async seedRevisions(
    meetingId: string,
    segments: { segmentId: string; revision: number }[],
    translations: { sourceSegmentId: string; revision: number }[] = [],
  ) {
    for (const segment of segments) {
      const key = `${meetingId}:transcript:${segment.segmentId}`;
      this.revisions.set(key, Math.max(this.revisions.get(key) ?? 0, segment.revision));
    }
    for (const translation of translations) {
      const key = `${meetingId}:translation:${translation.sourceSegmentId}`;
      this.revisions.set(key, Math.max(this.revisions.get(key) ?? 0, translation.revision));
    }
  }
  async append(draft: PendingEnvelope) {
    if (this.fail) throw new Error('quota');
    const p = draft.payload;
    const key = `${draft.meetingId}:${p.kind === 'correction' ? 'transcript' : p.kind}:${p.kind === 'transcript' || p.kind === 'correction' ? p.segmentId : p.kind === 'translation' ? p.sourceSegmentId : p.gap.gapId}`;
    const revision =
      Math.max(this.revisions.get(key) ?? 0, p.kind === 'correction' ? p.baseRevision : 0) + 1;
    this.revisions.set(key, revision);
    const event = { ...draft, revision };
    this.events.push(event);
    return event;
  }
  async readBatch() {
    return this.events.filter((e) => e.meetingId === this.events[0]?.meetingId).slice(0, 100);
  }
  async acknowledge(ids: string[]) {
    this.events = this.events.filter((e) => !ids.includes(e.eventId));
  }
  async count() {
    return this.events.length;
  }
}

export function draft(text = 'hello'): PendingEnvelope {
  return {
    schemaVersion: 1,
    meetingId: '22222222-2222-4222-8222-222222222222',
    eventId: crypto.randomUUID(),
    writerId: '11111111-1111-4111-8111-111111111111',
    observedAt: new Date().toISOString(),
    monotonicMs: 1,
    connectionId: null,
    payload: {
      kind: 'transcript',
      provider: 'mock',
      mode: 'online_full',
      source: 'microphone',
      segmentId: 'one',
      text,
      status: 'final',
      startMs: 0,
    },
  };
}
