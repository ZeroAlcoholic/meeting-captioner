import { z } from 'zod';
import { CaptionTask } from './caption-task.js';
import { TranscriptEvent } from './transcript-event.js';
import { TranslationEvent } from './translation-event.js';
import { CaptureGap } from './health-event.js';

export const ArchiveServiceIdentity = z
  .object({
    workspaceId: z.string().min(1).max(128),
    buildId: z.string().min(1).max(128),
  })
  .strict();
export type ArchiveServiceIdentity = z.infer<typeof ArchiveServiceIdentity>;

const SampleGapRecord = z
  .object({
    gapId: z.string().uuid(),
    meetingId: z.string().uuid(),
    trackId: z.string().min(1),
    captureEpoch: z.string().min(1),
    startSample: z.number().int().nonnegative(),
    endSample: z.number().int().nonnegative(),
    sampleRate: z.number().int().positive(),
    state: z.enum(['pending', 'repairing', 'repaired', 'unrecoverable']),
    cause: z.string().max(500),
    alignment: z.enum(['exact_capture_range', 'estimated']),
  })
  .strict()
  .refine((v) => v.endSample >= v.startSample);
export const GapRecord = z.union([
  SampleGapRecord,
  CaptureGap.extend({
    gapId: z.string().uuid(),
    meetingId: z.string().uuid(),
    trackId: z.string().min(1),
    state: z.enum(['pending', 'repairing', 'repaired', 'unrecoverable']),
    cause: z.string().max(500),
    alignment: z.literal('estimated'),
    storageLoss: z.object({ lostCount: z.number().int().positive() }).strict().optional(),
  }).strict(),
]);
export type GapRecord = z.infer<typeof GapRecord>;
export const TranscriptCorrection = z
  .object({
    kind: z.literal('correction'),
    segmentId: z.string().min(1),
    text: z.string(),
    baseRevision: z.number().int().positive(),
    editor: z.string().min(1).max(200),
    source: z.literal('human'),
    editedAt: z.string().datetime(),
  })
  .strict();
export const MeetingPayload = z.union([
  TranscriptEvent.strict(),
  TranslationEvent.strict(),
  TranscriptCorrection,
  z.object({ kind: z.literal('gap'), gap: GapRecord }).strict(),
]);
export type MeetingPayload = z.infer<typeof MeetingPayload>;
export const MeetingEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    meetingId: z.string().uuid(),
    eventId: z.string().uuid(),
    writerId: z.string().uuid(),
    connectionId: z.string().nullable(),
    observedAt: z.string().datetime(),
    monotonicMs: z.number().nonnegative().finite(),
    revision: z.number().int().positive(),
    payload: MeetingPayload,
  })
  .strict();
export type MeetingEnvelope<T = MeetingPayload> = Omit<
  z.infer<typeof MeetingEnvelope>,
  'payload'
> & { payload: T };
export const MeetingMetadata = z
  .object({
    meetingId: z.string().uuid(),
    title: z.string().max(500),
    createdAt: z.string().datetime(),
    captionTask: CaptionTask,
    separateTracks: z.boolean().optional(),
  })
  .strict();
export type MeetingMetadata = z.infer<typeof MeetingMetadata>;
export const CommitReceipt = z.object({
  meetingId: z.string().uuid(),
  committedEventIds: z.array(z.string().uuid()),
  committedAt: z.string().datetime(),
});
export type CommitReceipt = z.infer<typeof CommitReceipt>;
export const FinalizeInput = z
  .object({
    pendingCount: z.number().int().nonnegative(),
    gaps: z.array(GapRecord),
    unfinishedTurns: z.array(z.string().max(500)),
  })
  .strict();
export type FinalizeInput = z.infer<typeof FinalizeInput>;
export type MeetingManifest = FinalizeInput & {
  lostCount?: number;
  unsavedSince?: string | null;
  unsavedUntil?: string | null;
  meetingId: string;
  lastSequence: number;
  lastRevision: number;
  finalCount: number;
  saved: boolean;
  finalizedAt: string;
};
export type ArchivedSegment = z.infer<typeof TranscriptEvent> & {
  revision: number;
  originalText: string;
};
export type ArchivedTranslation = z.infer<typeof TranslationEvent> & { revision: number };
export type MeetingSnapshot = {
  meeting: MeetingMetadata;
  events: MeetingEnvelope[];
  segments: ArchivedSegment[];
  translations: Record<string, ArchivedTranslation>;
  lastSequence: number;
  manifest: MeetingManifest | null;
};
export type MeetingPage = Omit<MeetingSnapshot, 'events'> & { totalSegments: number };
export type MeetingListing = MeetingMetadata & { manifest: MeetingManifest | null };

/** Bounded recovery metadata; includes translations that have no source transcript. */
export type MeetingRevisionPage = {
  revisions: Array<{ kind: 'transcript' | 'translation'; segmentId: string; revision: number }>;
  nextOffset: number | null;
};
