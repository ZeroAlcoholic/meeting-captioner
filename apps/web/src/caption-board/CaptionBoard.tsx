import { useSettingsStore } from '../settings/use-settings-store.js';
import { useCaptionStore } from '../store/use-caption-store.js';
import styles from './CaptionBoard.module.css';

const HISTORY_SIZE = 5;

export function CaptionBoard() {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const langPair = useSettingsStore((s) => s.langPair);

  const visible = segments.slice(-HISTORY_SIZE - 1);
  const current = visible.at(-1);
  const history = visible.slice(0, -1);

  if (!current) {
    return (
      <div className={styles.empty} data-lang-pair={langPair} data-testid="caption-empty">
        <p>Waiting for captions…</p>
      </div>
    );
  }

  // For a partial (in-progress) segment there is no translation yet.
  // Fall back to the most recently finalized segment's translation so the
  // Chinese caption stays visible while new English text is being spoken.
  const currentTranslation =
    translations[current.segmentId] ??
    translations[history.at(-1)?.segmentId ?? ''];

  return (
    <div className={styles.board} data-lang-pair={langPair}>
      <div className={styles.history} data-testid="caption-history">
        {history.map((seg) => (
          <div key={seg.segmentId} className={styles.historyRow}>
            <span className={styles.historyTarget}>
              {translations[seg.segmentId]?.targetText ?? '—'}
            </span>
            <span className={styles.historySource}>{seg.text}</span>
          </div>
        ))}
      </div>

      <div
        className={styles.current}
        data-testid="caption-current"
        data-status={current.status}
      >
        <div
          className={styles.target}
          data-testid="caption-target"
          data-status={currentTranslation?.status ?? 'pending'}
        >
          {currentTranslation?.targetText ?? '…'}
        </div>
        <div className={styles.source} data-testid="caption-source">
          {current.text}
          {current.status !== 'final' && <span className={styles.cursor}>▍</span>}
        </div>
      </div>
    </div>
  );
}
