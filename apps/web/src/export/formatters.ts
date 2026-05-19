import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';

export interface ExportOptions {
  /** Include the source-language transcript line. Default true. */
  includeSource?: boolean;
  /** Include the target-language translation line. Default true. */
  includeTranslation?: boolean;
}

export interface SessionMetadata {
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs: number | null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function elapsedMs(startMs: number, sessionStartMs: number | null): number {
  if (sessionStartMs === null) return 0;
  return Math.max(0, startMs - sessionStartMs);
}

function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}

function formatSrtTime(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const millis = safe % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(millis, 3)}`;
}

function resolveSrtRange(
  segments: CaptionSegment[],
  index: number,
  sessionStartMs: number | null,
): { start: number; end: number } {
  const seg = segments[index]!;
  const startElapsed = elapsedMs(seg.startMs, sessionStartMs);
  // endMs is optional; fall back first to the next segment's start (clamped
  // so we don't end before we start) then to a 2-second default duration.
  if (seg.endMs !== undefined && seg.endMs > seg.startMs) {
    return { start: startElapsed, end: elapsedMs(seg.endMs, sessionStartMs) };
  }
  const next = segments[index + 1];
  if (next && next.startMs > seg.startMs) {
    return { start: startElapsed, end: Math.max(startElapsed + 1, elapsedMs(next.startMs, sessionStartMs) - 1) };
  }
  return { start: startElapsed, end: startElapsed + 2000 };
}

function resolveOpts(opts?: ExportOptions): Required<ExportOptions> {
  return {
    includeSource: opts?.includeSource ?? true,
    includeTranslation: opts?.includeTranslation ?? true,
  };
}

/**
 * Plain text: one paragraph per segment, source then translation on adjacent
 * lines, blank line between segments. Use when the user just wants the
 * transcript without timestamps or markup.
 */
export function toPlainText(
  { segments, translations }: SessionMetadata,
  opts?: ExportOptions,
): string {
  const o = resolveOpts(opts);
  const lines: string[] = [];
  for (const seg of segments) {
    const tr = translations[seg.segmentId];
    const block: string[] = [];
    if (o.includeSource) block.push(seg.text);
    if (o.includeTranslation && tr?.targetText) block.push(tr.targetText);
    if (block.length > 0) lines.push(block.join('\n'));
  }
  return lines.join('\n\n');
}

/**
 * SRT — standard subtitle format. Each segment becomes a numbered cue with
 * `HH:MM:SS,mmm --> HH:MM:SS,mmm` timing. Bilingual entries stack source
 * over translation inside a single cue (common SRT convention).
 */
export function toSrt(
  { segments, translations, sessionStartMs }: SessionMetadata,
  opts?: ExportOptions,
): string {
  const o = resolveOpts(opts);
  const blocks: string[] = [];
  let cue = 1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const tr = translations[seg.segmentId];
    const textLines: string[] = [];
    if (o.includeSource) textLines.push(seg.text);
    if (o.includeTranslation && tr?.targetText) textLines.push(tr.targetText);
    if (textLines.length === 0) continue;
    const { start, end } = resolveSrtRange(segments, i, sessionStartMs);
    blocks.push(
      `${cue}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${textLines.join('\n')}`,
    );
    cue += 1;
  }
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '');
}

/**
 * Markdown — meeting-note format. H1 header with session metadata, then per-
 * segment block: `[M:SS]` timestamp, source line, indented translation.
 */
export function toMarkdown(
  { segments, translations, sessionStartMs }: SessionMetadata,
  opts?: ExportOptions,
): string {
  const o = resolveOpts(opts);
  const lines: string[] = [];
  lines.push('# Meeting Transcript');
  const startedLabel =
    sessionStartMs !== null ? new Date(sessionStartMs).toISOString() : '(unknown)';
  lines.push('');
  lines.push(`*Started: ${startedLabel} · ${segments.length} segments*`);
  lines.push('');
  for (const seg of segments) {
    const tr = translations[seg.segmentId];
    const stamp = formatClock(elapsedMs(seg.startMs, sessionStartMs));
    const block: string[] = [];
    if (o.includeSource) block.push(`**[${stamp}]** ${seg.text}`);
    if (o.includeTranslation && tr?.targetText) {
      block.push(o.includeSource ? `> ${tr.targetText}` : `**[${stamp}]** ${tr.targetText}`);
    }
    if (block.length > 0) {
      lines.push(...block);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * JSON — machine-readable backup. Preserves segmentId / confidence / status
 * metadata that the other formats drop, so an external pipeline can re-run
 * analysis on the same data later. Pretty-printed for human inspection.
 */
export function toJson(meta: SessionMetadata): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      sessionStartMs: meta.sessionStartMs,
      segments: meta.segments,
      translations: meta.translations,
    },
    null,
    2,
  );
}

export type ExportFormat = 'txt' | 'srt' | 'md' | 'json';

export interface ExportArtifact {
  filename: string;
  mime: string;
  body: string;
}

/**
 * Build the downloadable artifact for a chosen format. Filename is timestamped
 * by sessionStartMs (or now() as a last resort) so multiple exports from one
 * session naturally sort together.
 */
export function buildExport(
  meta: SessionMetadata,
  format: ExportFormat,
  opts?: ExportOptions,
): ExportArtifact {
  const stampSource = meta.sessionStartMs ?? Date.now();
  const stamp = new Date(stampSource)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/Z$/, '');
  const base = `meeting-${stamp}`;
  switch (format) {
    case 'txt':
      return { filename: `${base}.txt`, mime: 'text/plain;charset=utf-8', body: toPlainText(meta, opts) };
    case 'srt':
      return { filename: `${base}.srt`, mime: 'application/x-subrip;charset=utf-8', body: toSrt(meta, opts) };
    case 'md':
      return { filename: `${base}.md`, mime: 'text/markdown;charset=utf-8', body: toMarkdown(meta, opts) };
    case 'json':
      return { filename: `${base}.json`, mime: 'application/json;charset=utf-8', body: toJson(meta) };
  }
}
