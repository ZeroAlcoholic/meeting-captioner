import { useEffect, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './RealtimePricingPanel.module.css';

// ─── Pricing constants ────────────────────────────────────────────────────────
//
// Source: OpenAI Realtime API pricing (verified May 2026).
//   gpt-realtime-translate ......... $0.034 / min realtime audio (flat)
//   gpt-realtime-whisper ........... $0.017 / min realtime audio (flat)
//
// The previous version of this panel used `gpt-4o-realtime-preview` rates
// (token-based, $100/M audio in + $5/M text in + $20/M text out). That was
// off by an order of magnitude for the model we actually call —
// `gpt-realtime-translate` — which prices per minute of audio, NOT per
// token. Business users budgeting from the old numbers would have planned
// for ~10× the real bill. This rewrite mirrors OpenAI's documented flat
// per-minute rate exactly, and tracks translate / whisper minutes
// separately so the historical total stays correct even after the user
// toggles bilingual mode between sessions.

const TRANSLATE_USD_PER_MIN = 0.034;
const WHISPER_USD_PER_MIN = 0.017;
const TWD_PER_USD = 32; // fixed display-only rate; the bill is in USD

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(min: number): string {
  const totalSec = Math.floor(min * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtUsd(n: number): string {
  // Two decimals up to $100, four below — gives meaningful resolution on
  // a short 1-min demo while staying compact for a 1-hour meeting.
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function RealtimePricingPanel() {
  const langPair = useSettingsStore((s) => s.langPair);
  const sessionStartAt = useSettingsStore((s) => s.sessionStartAt);
  const translateMinutesAccum = useSettingsStore((s) => s.translateMinutesAccum);
  const whisperMinutesAccum = useSettingsStore((s) => s.whisperMinutesAccum);
  const activeSessionBilingual = useSettingsStore((s) => s.activeSessionBilingual);
  const includeSourceTranscript = useSettingsStore((s) => s.includeSourceTranscript);
  const resetSession = useSettingsStore((s) => s.resetSession);

  // Force re-render every second while a session is live so the timer and
  // cost both tick visibly. The interval cleans up on stop, and React's
  // dependency on sessionStartAt ensures we only run it when needed.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sessionStartAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [sessionStartAt]);

  const isLive = sessionStartAt !== null;
  // Live session contributes minutes-so-far AT THE SNAPSHOT MODE — using
  // the snapshot rather than the current toggle is what fixes the
  // "historical bilingual total recalculates wrong after later switching
  // to translation-only" regression flagged by Codex.
  const liveMin = isLive ? (Date.now() - sessionStartAt) / 60_000 : 0;
  const liveBilingual = isLive && activeSessionBilingual === true;
  const translateMin = translateMinutesAccum + liveMin;
  const whisperMin = whisperMinutesAccum + (liveBilingual ? liveMin : 0);
  const total = translateMin * TRANSLATE_USD_PER_MIN + whisperMin * WHISPER_USD_PER_MIN;
  const totalTWD = total * TWD_PER_USD;
  const hasData = translateMin > 0;

  // Tooltip rate reflects what the CURRENT live session is billed at (or
  // what the next Start would use, if not running).
  const tooltipBilingual = isLive ? liveBilingual : includeSourceTranscript;
  const ratePerMin = tooltipBilingual ? TRANSLATE_USD_PER_MIN + WHISPER_USD_PER_MIN : TRANSLATE_USD_PER_MIN;
  const rateLabel = `$${ratePerMin.toFixed(3)}/min ${tooltipBilingual ? 'bilingual' : 'translate'}`;

  return (
    <div
      className={styles.chip}
      title={
        `OpenAI Realtime pricing — ${rateLabel}.\n` +
        `Translate minutes: ${translateMin.toFixed(2)}  Whisper minutes: ${whisperMin.toFixed(2)}.\n` +
        `Source: openai.com/api/pricing\n` +
        `Displayed total is wall-clock × rate per mode; the actual OpenAI invoice may differ slightly depending on session start/stop boundaries.`
      }
    >
      {isLive && <span className={styles.liveDot} aria-label="Live" />}
      <span className={styles.timer} data-live={isLive}>{fmtDuration(translateMin)}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.cost}>
        {hasData ? `${fmtUsd(total)} ≈ NT$${Math.round(totalTWD)}` : '—'}
      </span>
      <span className={styles.pair}>{langPair}</span>
      {!isLive && hasData && (
        <button
          type="button"
          className={styles.resetBtn}
          onClick={resetSession}
          aria-label="Reset session cost"
        >
          ↺
        </button>
      )}
    </div>
  );
}
