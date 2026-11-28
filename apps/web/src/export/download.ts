import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { meetingArchive } from '../store/meeting-archive.js';
import { buildExport, type ExportFormat } from './formatters.js';

/** Online translation exports use the complete archive, never the bounded display history. */
export async function downloadArchivedTranslation(
  format: ExportFormat,
  summary?: string,
): Promise<boolean> {
  const state = captionStore.getState();
  if (
    !state.sessionId ||
    state.captionTask?.purpose !== 'translation' ||
    (state.sessionMode !== 'real' && state.sessionMode !== 'gemini')
  )
    return false;
  const meetingId = state.sessionId;
  meetingArchive.checkpoint();
  await meetingArchive.flushPending();
  const useSnapshot = format === 'md' || (format === 'txt' && Boolean(summary?.trim()));
  const blob = await meetingArchive.exportMeeting(
    meetingId,
    'corrected',
    useSnapshot ? 'json' : format,
  );
  if (useSnapshot) {
    const snapshot = JSON.parse(await blob.text()) as {
      segments: CaptionSegment[];
      translations: Record<string, CaptionTranslation>;
    };
    const artifact = buildExport(
      { ...snapshot, sessionStartMs: state.sessionStartMs, summary },
      format,
    );
    triggerDownload(artifact.body, artifact.filename, artifact.mime);
  } else {
    triggerDownload(await blob.text(), `${meetingId}-corrected.${format}`, blob.type);
  }
  return true;
}

/**
 * Trigger a browser download for an in-memory blob. Standard Blob + anchor +
 * click + revoke pattern. The anchor is appended to document.body before the
 * click — some browsers ignore clicks on detached anchors.
 */
export function triggerDownload(body: string | Blob, filename: string, mime: string): void {
  if (typeof document === 'undefined') return; // SSR / test environment guard
  const blob = typeof body === 'string' ? new Blob([body], { type: mime }) : body;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Release the object URL on the next tick so the click has time to be
  // dispatched. Some browsers revoke too eagerly otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
