import { useEffect, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './RealtimePricingPanel.module.css';

// ─── Pricing constants ────────────────────────────────────────────────────────
// gpt-4o-realtime-preview rates — hardcoded, no API calls (rates as of 2025-01)
const AUDIO_IN_PER_M  = 100;   // USD / 1M audio input  tokens
const TEXT_IN_PER_M   = 5;     // USD / 1M text  input  tokens
const TEXT_OUT_PER_M  = 20;    // USD / 1M text  output tokens

// 1 audio token = 100 ms of audio = 10 tokens/sec (OpenAI Realtime spec)
const AUDIO_TOKENS_PER_SEC = 10;

// Session instructions sent once at start — ~70 tokens text input
const SESSION_PROMPT_TOKENS = 70;

// Assumed speech activity ratio within the session duration
const SPEECH_RATIO = 0.65;

// Translation token ratios relative to spoken English-token equivalent
const ZH_OUTPUT_RATIO = 0.55;   // Chinese out ≈ 55% of English token count
const EN_OUTPUT_RATIO = 1.40;   // English out ≈ 140% (expansion from Chinese)

// Words per minute while actively speaking in a business meeting
const WORDS_PER_MIN = 120;
const EN_TOKENS_PER_WORD = 1.3;

const TWD_PER_USD = 32; // fixed exchange rate

// ─── Helpers ─────────────────────────────────────────────────────────────────
interface CostBreakdown {
  durationSec:    number;
  audioInTokens:  number;
  textInTokens:   number;
  textOutTokens:  number;
  audioInCost:    number;
  textInCost:     number;
  textOutCost:    number;
  total:          number;
  totalTWD:       number;
}

function calcCost(elapsedMs: number, langPair: string): CostBreakdown {
  const durationSec = elapsedMs / 1000;
  const speechSec   = durationSec * SPEECH_RATIO;

  const audioInTokens = Math.round(speechSec * AUDIO_TOKENS_PER_SEC);
  const textInTokens  = SESSION_PROMPT_TOKENS;

  const wordsSpoken    = (speechSec / 60) * WORDS_PER_MIN;
  const enTokensEquiv  = wordsSpoken * EN_TOKENS_PER_WORD;
  const textOutTokens  = Math.round(
    langPair === 'zh-TW→en' ? enTokensEquiv * EN_OUTPUT_RATIO : enTokensEquiv * ZH_OUTPUT_RATIO,
  );

  const audioInCost = (audioInTokens / 1_000_000) * AUDIO_IN_PER_M;
  const textInCost  = (textInTokens  / 1_000_000) * TEXT_IN_PER_M;
  const textOutCost = (textOutTokens / 1_000_000) * TEXT_OUT_PER_M;
  const total       = audioInCost + textInCost + textOutCost;

  return {
    durationSec, audioInTokens, textInTokens, textOutTokens,
    audioInCost, textInCost, textOutCost,
    total, totalTWD: total * TWD_PER_USD,
  };
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtUsd(n: number): string { return `$${n.toFixed(4)}`; }
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// ─── Component ────────────────────────────────────────────────────────────────
export function RealtimePricingPanel() {
  const langPair        = useSettingsStore((s) => s.langPair);
  const sessionStartAt  = useSettingsStore((s) => s.sessionStartAt);
  const sessionElapsedMs = useSettingsStore((s) => s.sessionElapsedMs);
  const resetSession    = useSettingsStore((s) => s.resetSession);

  // Force re-render every second while a session is live
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sessionStartAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [sessionStartAt]);

  const isLive    = sessionStartAt !== null;
  const totalMs   = sessionElapsedMs + (isLive ? Date.now() - sessionStartAt : 0);
  const hasData   = totalMs > 0;
  const bk        = calcCost(totalMs, langPair);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Realtime API Cost Estimate</span>
        <span className={styles.model}>gpt-4o-realtime-preview · {langPair}</span>
        <div className={styles.timerGroup}>
          {isLive && <span className={styles.liveDot} aria-label="Live" />}
          <span className={styles.timer} data-live={isLive}>
            {fmtDuration(totalMs)}
          </span>
          {!isLive && hasData && (
            <button
              type="button"
              className={styles.resetBtn}
              onClick={resetSession}
              aria-label="Reset session cost"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {!hasData ? (
        <p className={styles.idle}>Start a Realtime session to track cost automatically.</p>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Item</th>
                <th>Tokens</th>
                <th>Rate (USD/1M)</th>
                <th>Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Audio input (mic stream)</td>
                <td>{fmtTokens(bk.audioInTokens)}</td>
                <td>${AUDIO_IN_PER_M}</td>
                <td>{fmtUsd(bk.audioInCost)}</td>
              </tr>
              <tr>
                <td>Text output (translation)</td>
                <td>{fmtTokens(bk.textOutTokens)}</td>
                <td>${TEXT_OUT_PER_M}</td>
                <td>{fmtUsd(bk.textOutCost)}</td>
              </tr>
              <tr className={styles.dimRow}>
                <td>Text input (session instructions)</td>
                <td>{fmtTokens(bk.textInTokens)}</td>
                <td>${TEXT_IN_PER_M}</td>
                <td>{fmtUsd(bk.textInCost)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className={styles.totalRow}>
                <td colSpan={3}>Estimated Total</td>
                <td>
                  <strong>{fmtUsd(bk.total)}</strong>
                  <span className={styles.twd}> ≈ NT${bk.totalTWD.toFixed(1)}</span>
                </td>
              </tr>
            </tfoot>
          </table>

          <div className={styles.assumptions}>
            <strong>Assumptions:</strong>{' '}
            audio input 10 tokens/sec · {Math.round(SPEECH_RATIO * 100)}% speech activity ·
            {langPair === 'zh-TW→en'
              ? ' Chinese→English expansion ×1.4'
              : ' English→Chinese compression ×0.55'}{' '}
            · audio output disabled (text-only session) · NT$1 ≈ US${(1 / TWD_PER_USD).toFixed(4)} (fixed)
          </div>
        </>
      )}
    </div>
  );
}
