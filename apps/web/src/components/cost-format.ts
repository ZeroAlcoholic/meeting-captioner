// Shared cost/timer formatting for the realtime pricing chips (OpenAI + Gemini).
// Kept tiny and dependency-free so both panels render identical-looking numbers.

/** Fixed display-only USD→TWD rate; the actual invoice is in USD. */
export const TWD_PER_USD = 32;

/** minutes → HH:MM:SS */
export function fmtDuration(min: number): string {
  const totalSec = Math.floor(min * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Two decimals at/above $1, four below — meaningful resolution on a short demo
 * while staying compact for a long meeting.
 */
export function fmtUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
