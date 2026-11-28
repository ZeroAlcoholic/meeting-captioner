import { ONLINE_SERVICE_URL } from '../config.js';
import { serviceFetch } from '../providers/service-fetch.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';

export interface SummaryResult {
  summary: string;
  provider: 'gemini' | 'openai';
  model: string;
  fallbackUsed: boolean;
}

const MAX_TRANSCRIPT_CHARS = 180_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatStamp(startMs: number, baseMs: number | null): string {
  const elapsed = baseMs !== null ? Math.max(0, startMs - baseMs) : 0;
  const totalSec = Math.floor(elapsed / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Assemble a timestamped bilingual transcript string from segments and
 * translations, bounded to MAX_TRANSCRIPT_CHARS so long meetings never
 * exceed the summary route limit.
 */
export function buildSummaryTranscript(
  segments: ReadonlyArray<Pick<CaptionSegment, 'segmentId' | 'text' | 'startMs'>>,
  translations: Readonly<Record<string, Pick<CaptionTranslation, 'targetText'>>> = {},
  sessionStartMs: number | null = null,
): string {
  if (segments.length === 0) return '';
  const baseMs = sessionStartMs ?? segments[0]?.startMs ?? null;
  const lines: string[] = [];
  for (const seg of segments) {
    const source = seg.text.trim();
    const target = translations[seg.segmentId]?.targetText?.trim() ?? '';
    if (!source && !target) continue;
    const stamp = formatStamp(seg.startMs, baseMs);
    if (source && target && source !== target) {
      lines.push(`[${stamp}] ${source} | ${target}`);
    } else {
      lines.push(`[${stamp}] ${target || source}`);
    }
  }
  const joined = lines.join('\n');
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return joined.slice(-MAX_TRANSCRIPT_CHARS);
}

/**
 * Request a post-meeting summary via serviceFetch('/summarize').
 * Works identically on Desktop (services/online) and Mobile (device-broker).
 */
export async function requestMeetingSummary(options: {
  transcript: string;
  preferredProvider?: 'gemini' | 'openai';
  gaps?: string[];
  signal?: AbortSignal;
}): Promise<SummaryResult> {
  const text = options.transcript.trim();
  if (!text) {
    throw new Error('尚無可摘要的逐字稿內容');
  }
  const res = await serviceFetch(`${ONLINE_SERVICE_URL}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript: text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text,
      ...(options.preferredProvider ? { preferredProvider: options.preferredProvider } : {}),
      ...(options.gaps && options.gaps.length > 0 ? { gaps: options.gaps.slice(0, 50) } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('摘要服務金鑰被拒絕或受 IP 白名單限制，請檢查 Gemini／OpenAI 金鑰設定。');
    }
    if (res.status === 429) {
      throw new Error('摘要請求達速率上限，請稍候再試。');
    }
    if (res.status === 503) {
      throw new Error('尚未設定可用的摘要金鑰（GEMINI_API_KEY 或 OPENAI_API_KEY）。');
    }
    if (res.status === 504) {
      throw new Error('摘要生成逾時，請再試一次。');
    }
    throw new Error(`摘要生成失敗（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as Partial<SummaryResult>;
  if (typeof data.summary !== 'string' || !data.summary.trim()) {
    throw new Error('摘要服務回傳空內容');
  }
  return {
    summary: data.summary.trim(),
    provider: data.provider === 'openai' ? 'openai' : 'gemini',
    model: typeof data.model === 'string' ? data.model : 'gemini-3.8-flash',
    fallbackUsed: Boolean(data.fallbackUsed),
  };
}
