import { expect, it } from 'vitest';
import { exportMeeting } from './meeting-export.js';
import type { MeetingSnapshot } from '@meeting-audio/contracts';
it('exports original and corrected text from a single snapshot with scope metadata', () => {
  const snapshot = {
    meeting: { meetingId: 'm' },
    events: [],
    segments: [
      {
        segmentId: 's',
        text: '校訂',
        originalText: '原稿',
        rawText: '原稿raw',
        startMs: 0,
        endMs: 1200,
        status: 'final',
        revision: 2,
      },
    ],
    lastSequence: 7,
    manifest: null,
  } as unknown as MeetingSnapshot;
  expect(exportMeeting(snapshot, 'original', 'txt')).toBe('原稿');
  expect(exportMeeting(snapshot, 'corrected', 'txt')).toBe('校訂');
  expect(exportMeeting(snapshot, 'corrected', 'srt')).toContain(
    '00:00:00,000 --> 00:00:01,200\n校訂',
  );
  expect(JSON.parse(exportMeeting(snapshot, 'original', 'json'))).toMatchObject({
    metadata: {
      lastSequence: 7,
      variant: 'original',
      timingPrecision: 'estimated',
      finalized: false,
    },
    segments: [{ text: '原稿', rawText: '原稿raw' }],
  });
});
it('uses the stable meeting start for epoch timestamps across retries', () => {
  const origin = Date.parse('2026-10-08T08:00:00.000Z');
  const snapshot = {
    meeting: { createdAt: '2026-10-08T08:00:00.000Z', captionTask: { purpose: 'transcription' } },
    events: [],
    segments: [
      {
        segmentId: 'first',
        text: 'first',
        originalText: 'first',
        startMs: origin + 1000,
        endMs: origin + 2000,
      },
      {
        segmentId: 'retry',
        text: 'retry',
        originalText: 'retry',
        startMs: origin + 60000,
        endMs: origin + 61000,
      },
    ],
    lastSequence: 2,
    manifest: null,
    translations: {},
  } as unknown as MeetingSnapshot;
  const srt = exportMeeting(snapshot, 'corrected', 'srt');
  expect(srt).toContain('00:00:01,000 --> 00:00:02,000');
  expect(srt).toContain('00:01:00,000 --> 00:01:01,000');
});
it('exports source and target in translation meetings while pure captions stay single', () => {
  const snapshot = {
    meeting: { captionTask: { purpose: 'translation' } },
    events: [],
    segments: [
      {
        segmentId: 's',
        text: 'corrected source',
        originalText: 'original source',
        startMs: 0,
        endMs: 1000,
      },
    ],
    translations: { s: { targetText: '翻譯', sourceSegmentId: 's' } },
    lastSequence: 2,
    manifest: null,
  } as unknown as MeetingSnapshot;
  expect(exportMeeting(snapshot, 'original', 'txt')).toBe('original source\n翻譯');
  expect(exportMeeting(snapshot, 'corrected', 'srt')).toContain('corrected source\n翻譯');
  snapshot.meeting.captionTask = {
    purpose: 'transcription',
    inputLanguages: ['en'],
    textPolicy: 'zh-TW-preserve-original',
  };
  expect(exportMeeting(snapshot, 'corrected', 'txt')).toBe('corrected source');
});
it('keeps translation-only turns when a provider did not emit a source segment', () => {
  const snapshot = {
    meeting: { createdAt: '2026-10-08T00:00:00.000Z', captionTask: { purpose: 'translation' } },
    segments: [],
    translations: {
      orphan: {
        sourceSegmentId: 'orphan',
        sourceText: 'source',
        targetText: 'target',
        updatedAt: '2026-10-08T00:00:02.000Z',
      },
    },
    events: [],
    lastSequence: 1,
    manifest: null,
  } as unknown as MeetingSnapshot;
  expect(exportMeeting(snapshot, 'original', 'txt')).toBe('source\ntarget');
  expect(exportMeeting(snapshot, 'corrected', 'srt')).toContain(
    '00:00:02,000 --> 00:00:04,000\nsource\ntarget',
  );
});
