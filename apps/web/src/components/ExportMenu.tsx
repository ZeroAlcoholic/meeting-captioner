import { useEffect, useRef, useState } from 'react';
import { useCaptionStore } from '../store/use-caption-store.js';
import { buildExport, type ExportFormat } from '../export/formatters.js';
import { triggerDownload, downloadArchivedTranslation } from '../export/download.js';
import styles from './ExportMenu.module.css';

const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: 'md', label: 'Markdown', hint: '.md — meeting notes' },
  { id: 'txt', label: 'Plain text', hint: '.txt — clean transcript' },
  { id: 'srt', label: 'SRT', hint: '.srt — video subtitle' },
  { id: 'json', label: 'JSON', hint: '.json — full backup' },
];

export interface ExportMenuProps {
  /** Hide the menu while a session is running to avoid mid-meeting misclicks. */
  disabled?: boolean;
}

/**
 * Header dropdown that turns the live captionStore content into a downloaded
 * file in the user's chosen format. Pure side-effect on click — no provider
 * coupling, no Realtime API call. The button is disabled when there are no
 * segments to export, or when `disabled` prop is true (e.g. session running).
 */
export function ExportMenu({ disabled = false }: ExportMenuProps) {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const sessionStartMs = useCaptionStore((s) => s.sessionStartMs);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const hasData = segments.length > 0;
  const buttonDisabled = disabled || !hasData || exporting;

  // Outside-click + Escape dismiss, matching SettingsPanel behaviour.
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

  const handleExport = async (format: ExportFormat): Promise<void> => {
    setExporting(true);
    setError(null);
    try {
      if (!(await downloadArchivedTranslation(format))) {
        const artifact = buildExport({ segments, translations, sessionStartMs }, format);
        triggerDownload(artifact.body, artifact.filename, artifact.mime);
      }
      setOpen(false);
    } catch {
      setError('完整匯出失敗或仍有待保存資料，請保留此分頁並重試。');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        disabled={buttonDisabled}
        title={
          buttonDisabled
            ? hasData
              ? 'Export disabled during a running session'
              : 'No captions to export yet'
            : `Export ${segments.length} segments to a file`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="export-menu-toggle"
      >
        ⬇ Export
      </button>
      {open && !buttonDisabled && (
        <div role="menu" className={styles.menu} data-testid="export-menu">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => void handleExport(f.id)}
              data-testid={`export-${f.id}`}
            >
              <span className={styles.itemLabel}>{f.label}</span>
              <span className={styles.itemHint}>{f.hint}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
