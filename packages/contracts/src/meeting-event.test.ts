import { describe, expect, it } from 'vitest';
import { GapRecord, MeetingEnvelope, MeetingMetadata } from './meeting-event.js';
import { HealthEvent } from './health-event.js';
describe('meeting archive contracts', () => {
  it('retains optional dual-source ownership while accepting unchanged legacy metadata', () => {
    const metadata = {
      meetingId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      title: 'dual',
      createdAt: '2026-10-16T00:00:00.000Z',
      captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
    };
    expect(MeetingMetadata.parse(metadata)).toEqual(metadata);
    expect(MeetingMetadata.parse({ ...metadata, separateTracks: true }).separateTracks).toBe(true);
    expect(MeetingMetadata.safeParse({ ...metadata, separateTracks: 'true' }).success).toBe(false);
  });
  it('accepts a captured retention loss without changing existing health events', () => {
    const event = {
      kind: 'health',
      component: 'audio',
      state: 'connected',
      timestamp: '2026-10-16T00:00:00.000Z',
    };
    expect(HealthEvent.parse(event)).toEqual(event);
    const retentionGap = {
      gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      trackId: 'mic',
      captureEpoch: 'e1',
      from: 512,
      to: 1024,
      sampleRate: 16000,
    };
    expect(HealthEvent.parse({ ...event, retentionGap }).retentionGap).toEqual(retentionGap);
    expect(
      HealthEvent.safeParse({ ...event, retentionGap: { ...retentionGap, to: 0 } }).success,
    ).toBe(false);
    expect(
      HealthEvent.safeParse({ ...event, retentionGap: { ...retentionGap, to: 512 } }).success,
    ).toBe(false);
    expect(
      HealthEvent.safeParse({ ...event, retentionGap: { ...retentionGap, from: 0.5 } }).success,
    ).toBe(false);
  });
  it('roundtrips estimated wall-clock gaps without inventing captured samples', () => {
    const gap = {
      gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      meetingId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      trackId: 'mic',
      captureEpoch: 'grant-1',
      state: 'unrecoverable',
      cause: '疑似休眠或排程中斷',
      alignment: 'estimated',
      wallClock: { startAt: '2026-10-15T00:00:00.000Z', endAt: '2026-10-15T00:01:00.000Z' },
    };
    expect(GapRecord.parse(JSON.parse(JSON.stringify(gap)))).toEqual(gap);
    expect(GapRecord.safeParse({ ...gap, alignment: 'exact_capture_range' }).success).toBe(false);
    expect(
      GapRecord.safeParse({
        ...gap,
        wallClock: { ...gap.wallClock, endAt: '2026-10-14T00:00:00.000Z' },
      }).success,
    ).toBe(false);
  });
  it('requires a stable UUID identity and nonnegative revision', () => {
    expect(MeetingEnvelope.safeParse({ meetingId: '../escape', revision: -1 }).success).toBe(false);
  });
  it('continues to accept existing sample-aligned gap records', () => {
    const gap = {
      gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      meetingId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      trackId: 'mic',
      captureEpoch: 'old',
      startSample: 10,
      endSample: 20,
      sampleRate: 16000,
      state: 'unrecoverable',
      cause: 'old gap',
      alignment: 'exact_capture_range',
    };
    expect(GapRecord.parse(gap)).toEqual(gap);
  });
  it('retains the meeting purpose', () => {
    const value = {
      meetingId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      title: '會議',
      createdAt: '2026-10-08T00:00:00.000Z',
      captionTask: {
        purpose: 'transcription',
        inputLanguages: ['zh-tw'],
        textPolicy: 'zh-TW-preserve-original',
      },
    };
    expect(MeetingMetadata.parse(value)).toEqual(value);
  });
});
