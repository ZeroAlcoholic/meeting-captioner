import { randomUUID } from 'node:crypto';
import { open, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingSnapshot } from '@meeting-audio/contracts';

export type ExportVariant = 'original' | 'corrected';
export type ExportFormat = 'txt' | 'json' | 'srt';
function time(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  return (
    [Math.floor(value / 3600000), Math.floor(value / 60000) % 60, Math.floor(value / 1000) % 60]
      .map((n) => String(n).padStart(2, '0'))
      .join(':') +
    ',' +
    String(value % 1000).padStart(3, '0')
  );
}
/** The caller supplies one committed DB snapshot for all variants/formats. */
export function exportMeeting(
  snapshot: MeetingSnapshot,
  variant: ExportVariant,
  format: ExportFormat,
): string {
  const segments = snapshot.segments.map((segment) => ({
    ...segment,
    text: variant === 'original' ? segment.originalText : segment.text,
  }));
  const origin = Date.parse(snapshot.meeting.createdAt);
  const relative = (ms: number) => Math.max(0, ms - (Number.isFinite(origin) ? origin : 0));
  const text = (segment: (typeof segments)[number]) => {
    const translation =
      snapshot.meeting.captionTask?.purpose === 'translation'
        ? snapshot.translations?.[segment.segmentId]
        : undefined;
    return translation ? `${segment.text}\n${translation.targetText}` : segment.text;
  };
  const rows = segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: text(segment),
  }));
  if (snapshot.meeting.captionTask?.purpose === 'translation') {
    const sourceIds = new Set(segments.map((segment) => segment.segmentId));
    for (const translation of Object.values(snapshot.translations ?? {})) {
      if (sourceIds.has(translation.sourceSegmentId)) continue;
      const observed = Date.parse(translation.updatedAt);
      const startMs = Number.isFinite(observed) ? observed : Number.isFinite(origin) ? origin : 0;
      // Translation-only turns have no source timing: keep content with estimated bounds.
      rows.push({
        startMs,
        endMs: startMs + 2000,
        text: [translation.sourceText, translation.targetText].filter(Boolean).join('\n'),
      });
    }
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  if (format === 'txt') return rows.map((row) => row.text).join('\n');
  if (format === 'srt')
    return rows
      .map(
        (s, i) =>
          `${i + 1}\n${time(relative(s.startMs))} --> ${time(Math.max(relative(s.startMs) + 1, relative(s.endMs ?? rows[i + 1]?.startMs ?? s.startMs + 2000)))}\n${s.text}\n`,
      )
      .join('\n');
  return JSON.stringify(
    {
      metadata: {
        schemaVersion: 1,
        meeting: snapshot.meeting,
        variant,
        lastSequence: snapshot.lastSequence,
        segmentCount: segments.length,
        translationOnlyCount: rows.length - segments.length,
        timingPrecision: 'estimated',
        finalized: snapshot.manifest?.saved ?? false,
        manifest: snapshot.manifest,
      },
      segments,
      translations: snapshot.translations ?? {},
      events: snapshot.events,
    },
    null,
    2,
  );
}

/** fsync before atomic replace; a failed write preserves the prior complete file. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function refreshMeetingExports(
  dataDir: string,
  snapshot: MeetingSnapshot,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(snapshot.meeting.meetingId)) throw new Error('INVALID_MEETING_ID');
  const dir = join(dataDir, 'exports', snapshot.meeting.meetingId);
  await mkdir(dir, { recursive: true });
  for (const variant of ['original', 'corrected'] as const) {
    for (const format of ['txt', 'json', 'srt'] as const) {
      await atomicWrite(
        join(dir, `${variant}.${format}`),
        exportMeeting(snapshot, variant, format),
      );
    }
  }
}
