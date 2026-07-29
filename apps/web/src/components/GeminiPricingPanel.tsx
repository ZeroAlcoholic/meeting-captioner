import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { TWD_PER_USD, fmtDuration, fmtUsd } from './cost-format.js';
import styles from './RealtimePricingPanel.module.css';

// ─── Gemini Live pricing (ESTIMATE) ───────────────────────────────────────────
//
// The provider now uses the official speed-first Live Translate AUDIO output
// path. Even though this app discards synthesized audio, Gemini still generates
// translated audio and bills the audio output side. Basis (verified 2026-06-29,
// ai.google.dev/gemini-api/docs/pricing, Gemini 3.5 Live Translate):
//   • Audio input  ............... $0.0053 / min
//   • Audio output ............... $0.0315 / min
//   • Effective total ............ ~$0.0368 / min
// This is an estimate because actual billing is token-based, but it is no
// longer the old TEXT-output lower bound.
export const GEMINI_LIVE_USD_PER_MIN_EST = 0.0368;

export interface GeminiPricingPanelProps {
  /** True while the Gemini provider is actively capturing (drives the timer). */
  running: boolean;
}

/**
 * Cost/timer chip for the Gemini Live backend — the Gemini counterpart of
 * RealtimePricingPanel, so the operator sees elapsed time + an estimated spend
 * for Gemini too (previously only OpenAI showed any cost). Self-contained: it
 * times its own running windows (Gemini does not use the OpenAI session-cost
 * accumulators in the settings store) and accumulates across Pause/Resume.
 */
export function GeminiPricingPanel({ running }: GeminiPricingPanelProps) {
  const langPair = useSettingsStore((s) => s.langPair);

  // epoch ms of the current running window; null when paused/stopped.
  const liveStartRef = useRef<number | null>(null);
  // minutes from earlier completed windows this tab session (survives Pause).
  const accumMinRef = useRef(0);
  const [, setTick] = useState(0);

  // Open/close a timing window on each running transition.
  useEffect(() => {
    if (running) {
      if (liveStartRef.current === null) liveStartRef.current = Date.now();
    } else if (liveStartRef.current !== null) {
      accumMinRef.current += (Date.now() - liveStartRef.current) / 60_000;
      liveStartRef.current = null;
      setTick((t) => t + 1);
    }
  }, [running]);

  // Tick once a second while live so the timer + cost advance visibly.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const liveMin =
    running && liveStartRef.current !== null ? (Date.now() - liveStartRef.current) / 60_000 : 0;
  const totalMin = accumMinRef.current + liveMin;
  const cost = totalMin * GEMINI_LIVE_USD_PER_MIN_EST;
  const costTWD = cost * TWD_PER_USD;
  const hasData = totalMin > 0;

  const reset = (): void => {
    accumMinRef.current = 0;
    setTick((t) => t + 1);
  };

  return (
    <div
      className={styles.chip}
      title={
        `Gemini Live Translate 費用為估算（依音訊 token 計費）。\n` +
        `目前使用速度優先 AUDIO 輸出模式：音訊輸入約 $0.0053/min，音訊輸出約 $0.0315/min，合計約 $${GEMINI_LIVE_USD_PER_MIN_EST.toFixed(4)}/min。\n` +
        `此 app 丟棄合成音訊，但模型仍會產生並計費。\n` +
        `來源：ai.google.dev/gemini-api/docs/pricing`
      }
    >
      {running && <span className={styles.liveDot} aria-label="Live" />}
      <span className={styles.timer} data-live={running}>
        {fmtDuration(totalMin)}
      </span>
      <span className={styles.sep}>·</span>
      <span className={styles.cost}>
        {hasData ? `~${fmtUsd(cost)} ≈ NT$${Math.round(costTWD)}` : '估算 —'}
      </span>
      <span className={styles.pair}>{langPair}</span>
      {!running && hasData && (
        <button
          type="button"
          className={styles.resetBtn}
          onClick={reset}
          aria-label="Reset Gemini session cost"
        >
          ↺
        </button>
      )}
    </div>
  );
}
