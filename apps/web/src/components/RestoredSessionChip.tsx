import { useEffect, useRef, useState } from 'react';
import { useCaptionStore, captionStore } from '../store/use-caption-store.js';
import { buildExport, type ExportFormat } from '../export/formatters.js';
import { triggerDownload } from '../export/download.js';
import styles from './RestoredSessionChip.module.css';

/**
 * Header chip that appears when the app boots with captions hydrated from
 * localStorage but no session has been started in this tab yet. Click opens
 * a small menu with two paths:
 *
 *   - Export the restored captions to a file (Markdown — meeting-notes
 *     friendly default; the full multi-format ExportMenu is also still
 *     available in the header).
 *   - Clear the restored captions and start fresh — useful when the
 *     hydrated data is from a previous unrelated meeting.
 *
 * The chip self-dismisses the moment a new session begins (beginSession()
 * flips restoredFromStorage to false), so no manual dismiss is needed.
 */
export function RestoredSessionChip() {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const sessionStartMs = useCaptionStore((s) => s.sessionStartMs);
  const restoredFromStorage = useCaptionStore((s) => s.restoredFromStorage);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Outside-click + Escape dismiss, matching ExportMenu / SettingsPanel.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Chip only shows when we have data hydrated from a previous tab/session.
  // The flag flips off the moment the user clicks Start (beginSession() clears
  // it) or Clear (clear() clears it), so no extra dismiss state is needed.
  if (!restoredFromStorage || segments.length === 0) return null;

  const handleExport = (format: ExportFormat) => {
    const artifact = buildExport({ segments, translations, sessionStartMs }, format);
    triggerDownload(artifact.body, artifact.filename, artifact.mime);
    setOpen(false);
  };

  const handleClear = () => {
    captionStore.getState().clear();
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        title={`${segments.length} segments restored from previous session`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="restored-session-chip"
      >
        <span className={styles.icon}>📂</span>
        <span>已恢復 {segments.length} 段</span>
      </button>
      {open && (
        <div role="menu" className={styles.menu} data-testid="restored-session-menu">
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => handleExport('md')}
            data-testid="restored-export-md"
          >
            ⬇ 匯出歷史記錄 (Markdown)
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${styles.itemDanger}`}
            onClick={handleClear}
            data-testid="restored-clear"
          >
            🗑 清除歷史開新會議
          </button>
        </div>
      )}
    </div>
  );
}
