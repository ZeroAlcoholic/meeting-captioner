import { useState } from 'react';
import { buildExport, type ExportFormat } from '../export/formatters.js';
import { downloadArchivedTranslation, triggerDownload } from '../export/download.js';
import {
  buildSummaryTranscript,
  requestMeetingSummary,
  type SummaryResult,
} from '../export/summary-client.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { meetingArchive } from '../store/meeting-archive.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import { useCaptionStore } from '../store/use-caption-store.js';

export interface PostMeetingBarProps {
  /** Optional override for pure-caption archive view where segments come from ArchivePage. */
  pureArchiveMeeting?: {
    meetingId: string;
    title: string;
    createdAt: string;
    segments: ReadonlyArray<Pick<CaptionSegment, 'segmentId' | 'text' | 'startMs'>>;
    gaps?: string[];
  };
}

export function PostMeetingBar({ pureArchiveMeeting }: PostMeetingBarProps) {
  const storeSegments = useCaptionStore((s) => s.segments);
  const storeTranslations = useCaptionStore((s) => s.translations);
  const sessionStartMs = useCaptionStore((s) => s.sessionStartMs);
  const sessionId = useCaptionStore((s) => s.sessionId);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);

  const [downloading, setDownloading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hasContent = pureArchiveMeeting
    ? pureArchiveMeeting.segments.length > 0
    : storeSegments.length > 0;
  if (!hasContent) return null;

  const handleDownloadTranscript = async (
    format: ExportFormat = 'md',
    withSummary?: string,
  ): Promise<void> => {
    setDownloading(true);
    setError(null);
    try {
      if (pureArchiveMeeting) {
        const blob = await meetingArchive.exportMeeting(
          pureArchiveMeeting.meetingId,
          'corrected',
          'txt',
        );
        const text = await blob.text();
        const body = withSummary?.trim()
          ? format === 'md'
            ? `# ${pureArchiveMeeting.title || '會議紀錄'}\n\n## 會議精準摘要\n\n${withSummary.trim()}\n\n---\n\n## 完整逐字稿\n\n${text}`
            : `=== 會議精準摘要 ===\n${withSummary.trim()}\n\n=== 完整逐字稿 ===\n${text}`
          : text;
        const ext = format === 'md' ? 'md' : 'txt';
        const mime = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
        triggerDownload(
          body,
          `${pureArchiveMeeting.meetingId}-${withSummary ? 'report' : 'transcript'}.${ext}`,
          mime,
        );
        return;
      }

      if (!(await downloadArchivedTranslation(format, withSummary))) {
        const artifact = buildExport(
          {
            segments: storeSegments,
            translations: storeTranslations,
            sessionStartMs,
            summary: withSummary,
          },
          format,
        );
        triggerDownload(artifact.body, artifact.filename, artifact.mime);
      }
    } catch {
      setError('完整逐字稿下載失敗，請確認本機保存狀態後重試。');
    } finally {
      setDownloading(false);
    }
  };

  const handleSummarize = async (): Promise<void> => {
    setSummarizing(true);
    setError(null);
    setCopied(false);
    try {
      let transcript = '';
      let gaps: string[] | undefined;

      if (pureArchiveMeeting) {
        try {
          const blob = await meetingArchive.exportMeeting(
            pureArchiveMeeting.meetingId,
            'corrected',
            'txt',
          );
          transcript = (await blob.text()).trim();
        } catch {
          /* fallback to loaded page segments */
        }
        if (!transcript) {
          transcript = buildSummaryTranscript(
            pureArchiveMeeting.segments,
            {},
            Date.parse(pureArchiveMeeting.createdAt) || null,
          );
        }
        gaps = pureArchiveMeeting.gaps;
      } else {
        if (sessionId) {
          try {
            meetingArchive.checkpoint();
            await meetingArchive.flushPending();
            const blob = await meetingArchive.exportMeeting(sessionId, 'corrected', 'json');
            const snapshot = JSON.parse(await blob.text()) as {
              segments?: CaptionSegment[];
              translations?: Record<string, CaptionTranslation>;
            };
            if (snapshot.segments && snapshot.segments.length > 0) {
              transcript = buildSummaryTranscript(
                snapshot.segments,
                snapshot.translations ?? {},
                sessionStartMs,
              );
            }
          } catch {
            /* fallback to in-memory store */
          }
        }
        if (!transcript) {
          transcript = buildSummaryTranscript(storeSegments, storeTranslations, sessionStartMs);
        }
        const archiveGaps = meetingArchive.getStatus().manifest?.gaps ?? [];
        if (archiveGaps.length > 0) {
          gaps = archiveGaps.map((g) => g.cause || '收音或連線中斷缺口');
        }
      }

      const result = await requestMeetingSummary({
        transcript,
        preferredProvider: onlineProvider,
        ...(gaps && gaps.length > 0 ? { gaps } : {}),
      });
      setSummaryResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '摘要生成失敗，請稍後再試。');
    } finally {
      setSummarizing(false);
    }
  };

  const handleCopySummary = async (): Promise<void> => {
    if (!summaryResult) return;
    try {
      await navigator.clipboard.writeText(summaryResult.summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError('無法複製到剪貼簿，請直接選取文字複製或下載報告。');
    }
  };

  return (
    <section
      className="post-meeting-bar"
      aria-label="會後匯出與精準摘要"
      data-testid="post-meeting-bar"
    >
      <div className="post-meeting-actions">
        <span className="post-meeting-title">會議已結束</span>
        <button
          type="button"
          className="post-meeting-btn post-meeting-btn-primary"
          disabled={downloading}
          onClick={() => void handleDownloadTranscript(pureArchiveMeeting ? 'txt' : 'md')}
          data-testid="one-click-download-transcript"
        >
          {downloading ? '下載中…' : '⬇ 一鍵下載完整逐字稿'}
        </button>
        <button
          type="button"
          className="post-meeting-btn post-meeting-btn-accent"
          disabled={summarizing}
          onClick={() => void handleSummarize()}
          data-testid="generate-meeting-summary"
        >
          {summarizing
            ? '✦ 正在生成精準摘要…'
            : summaryResult
              ? '✦ 重新產生精準摘要'
              : '✦ 產生精準商務摘要'}
        </button>
        {summaryResult && (
          <>
            <button
              type="button"
              className="post-meeting-btn"
              onClick={() => void handleCopySummary()}
              data-testid="copy-meeting-summary"
            >
              {copied ? '✓ 已複製摘要' : '複製摘要'}
            </button>
            <button
              type="button"
              className="post-meeting-btn"
              disabled={downloading}
              onClick={() => void handleDownloadTranscript('md', summaryResult.summary)}
              data-testid="download-summary-report-md"
            >
              ⬇ 下載摘要＋完整逐字稿 (.md)
            </button>
            <button
              type="button"
              className="post-meeting-btn"
              disabled={downloading}
              onClick={() => void handleDownloadTranscript('txt', summaryResult.summary)}
              data-testid="download-summary-report-txt"
            >
              ⬇ 下載摘要＋完整逐字稿 (.txt)
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="post-meeting-error" role="alert">
          {error}
        </p>
      )}
      {summaryResult && (
        <details className="post-meeting-summary" open data-testid="meeting-summary-card">
          <summary>
            <strong>AI 會議精準摘要</strong>
            <span className="post-meeting-meta">
              由 {summaryResult.provider === 'gemini' ? 'Gemini' : 'OpenAI'} ({summaryResult.model})
              產出
              {summaryResult.fallbackUsed ? ' · 已自動切換備援引擎' : ''}
            </span>
          </summary>
          <pre className="post-meeting-summary-body">{summaryResult.summary}</pre>
        </details>
      )}
    </section>
  );
}
