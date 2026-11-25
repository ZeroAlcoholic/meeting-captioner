import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useGeminiLive } from '../providers/use-gemini-live.js';
import { useOpenAIRealtime } from '../providers/use-openai-realtime.js';
import { resumeCaptureContext } from '../providers/audio-engine.js';
import { clearRecoveryRefusal, permanentRecoveryFailure } from '../providers/recovery-attempt.js';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';
import type { LangPair, MicDistance, OnlineProvider } from '../settings/settings-store.js';
import { captionStore, useCaptionStore } from '../store/use-caption-store.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import { deviceBrokerFetch } from './device-broker.js';
import {
  getDeviceKeys,
  maskKey,
  setDeviceKey,
  subscribeDeviceKeys,
  type DeviceKeyProvider,
  type DeviceKeys,
} from './device-keys.js';

/**
 * Phone build skips server /session/info polling, idle auto-prewarm (avoids
 * double-minting right after key test), and the 60s PCM retention ring buffer
 * (no archive or backfill on mobile).
 */
const MOBILE_PROVIDER_OPTIONS = {
  disablePolling: true,
  disableAutoPrewarm: true,
  retainAudio: false,
} as const;

/**
 * Determine provider start order from saved keys and current selection.
 * If both keys are present, try the selected provider first (e.g. OpenAI inside
 * an allowed Wi-Fi domain), then fall back to the other on startup failure.
 */
export function resolveStartOrder(
  preferred: OnlineProvider,
  keys: DeviceKeys,
): DeviceKeyProvider[] {
  const other: DeviceKeyProvider = preferred === 'openai' ? 'gemini' : 'openai';
  const order: DeviceKeyProvider[] = [];
  if (keys[preferred]) order.push(preferred);
  if (keys[other]) order.push(other);
  return order;
}

/** Rendered tail. The store is bounded too; this keeps scrolling light on a phone. */
const RENDERED_SEGMENTS = 150;
const FONT_KEY = 'meeting-captioner.font-step.v1';
const FONT_STEPS = [1.15, 1.4, 1.7, 2.1] as const;

const PROVIDERS: Array<{
  id: DeviceKeyProvider;
  label: string;
  keyUrl: string;
  keyHost: string;
  hint: string;
}> = [
  {
    id: 'gemini',
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHost: 'aistudio.google.com',
    hint: '費用較低，建議先用這個。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHost: 'platform.openai.com',
    hint: '限定 IP 的公司金鑰在行動網路會被拒絕，請用個人專案金鑰。',
  },
];

function useDeviceKeys() {
  return useSyncExternalStore(subscribeDeviceKeys, getDeviceKeys, getDeviceKeys);
}

function readFontStep(): number {
  try {
    const raw = localStorage.getItem(FONT_KEY);
    const value = raw === null ? NaN : Number(raw); // Number(null) is 0, not "unset"
    return Number.isInteger(value) && value >= 0 && value < FONT_STEPS.length ? value : 1;
  } catch {
    return 1;
  }
}

/** Keep the screen on while captioning; the OS drops the lock whenever the tab hides. */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (cancelled) void sentinel.release();
          else lock = sentinel;
        })
        .catch(() => {
          /* low battery / unsupported: captions still work, screen may dim */
        });
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [active]);
}

// ─── Reader ──────────────────────────────────────────────────────────────────

const Line = memo(function Line({
  segment,
  translation,
  bilingual,
}: {
  segment: CaptionSegment;
  translation: CaptionTranslation | undefined;
  bilingual: boolean;
}) {
  // Translation failed or absent → keep the source visible, never a blank row.
  const primary = translation?.targetText || segment.text;
  const secondary = translation?.targetText ? segment.text : '';
  if (!primary) return null;
  return (
    <div className="m-line">
      <p className="m-primary">{primary}</p>
      {bilingual && secondary && <p className="m-secondary">{secondary}</p>}
    </div>
  );
});

function LiveLine({ bilingual }: { bilingual: boolean }) {
  const live = useCaptionStore((s) => s.livePartial);
  const translation = useCaptionStore((s) =>
    s.liveTranslation &&
    s.livePartial &&
    s.liveTranslation.sourceSegmentId === s.livePartial.segmentId
      ? s.liveTranslation
      : null,
  );
  if (!live) return null;
  const target = translation?.targetText ?? '';
  return (
    <div className="m-line m-live" data-testid="m-live">
      {target ? (
        <p className="m-primary">{target}</p>
      ) : (
        // The translation trails the speech by a moment; show what has been
        // heard so the screen never looks stalled.
        <p className="m-primary m-pending">{live.text || '…'}</p>
      )}
      {bilingual && target && live.text && <p className="m-secondary">{live.text}</p>}
    </div>
  );
}

function statusLabel(
  running: boolean,
  transport: string,
  audio: string,
  offline: boolean,
): [string, string] {
  if (!running) return ['idle', '未開始'];
  if (offline) return ['bad', '無網路連線'];
  if (audio === 'requesting_permission') return ['wait', '請允許麥克風'];
  if (audio === 'failed' || audio === 'no_audio_track') return ['bad', '收不到麥克風'];
  if (audio === 'degraded') return ['wait', '收音已暫停'];
  if (transport === 'reconnecting') return ['wait', '重新連線中'];
  if (transport === 'failed' || transport === 'api_error') return ['bad', '連線中斷，重試中'];
  if (audio === 'silence_detected') return ['ok', '現場安靜中'];
  if (transport === 'connected') return ['ok', '聆聽中'];
  return ['wait', '連線中'];
}

/** Isolated subscriber so 10 Hz audio level updates never re-render the reader. */
function AudioPulse({ active }: { active: boolean }) {
  const rmsDb = useSettingsStore((s) => s.audioLevel?.rmsDb ?? -60);
  if (!active) return null;
  const level = Math.max(0.15, Math.min(1, (rmsDb + 55) / 40));
  return (
    <span
      className="m-meter"
      aria-hidden="true"
      style={{ '--m-level': level.toFixed(2) } as React.CSSProperties}
    >
      <i />
      <i />
      <i />
    </span>
  );
}

function Reader({ running, fontStep }: { running: boolean; fontStep: number }) {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const liveText = useCaptionStore(
    (s) => `${s.livePartial?.text ?? ''}|${s.liveTranslation?.targetText ?? ''}`,
  );
  const hasLive = useCaptionStore((s) => s.livePartial !== null);
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const shown = segments.length > RENDERED_SEGMENTS ? segments.slice(-RENDERED_SEGMENTS) : segments;

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowJump(!pinned.current);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [segments, translations, liveText, bilingual, fontStep]);

  const empty = shown.length === 0 && !hasLive;
  return (
    <main className="m-reader" ref={scroller} onScroll={onScroll} data-testid="m-reader">
      {segments.length > shown.length && (
        <p className="m-note">較早的內容已收合；按「複製全文」可取得完整內容。</p>
      )}
      {shown.map((segment) => (
        <Line
          key={segment.segmentId}
          segment={segment}
          translation={translations[segment.segmentId]}
          bilingual={bilingual}
        />
      ))}
      <LiveLine bilingual={bilingual} />
      {empty && (
        <p className="m-empty">
          {running
            ? '開始說話，字幕會出現在這裡。'
            : '按下方「開始」，手機會聽現場的聲音並即時顯示字幕。'}
        </p>
      )}
      {showJump && (
        <button
          type="button"
          className="m-jump"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            pinned.current = true;
            setShowJump(false);
          }}
        >
          ↓ 回到最新
        </button>
      )}
    </main>
  );
}

/**
 * Providers report failures in terms meant for logs. Say what happened and
 * what to do; keep the original only when nothing more useful is known.
 */
export function friendlyError(message: string): string {
  if (/ip_not_authorized/i.test(message))
    return '目前網路 IP 未在 OpenAI 白名單內。請切換至公司 Wi-Fi 或改用 Gemini。';
  if (/unsupported|auth|invalid_api_key|\b40[0134]\b/i.test(message))
    return '金鑰無法使用。請到「設定」測試或更換金鑰。';
  if (/rate-limit|\b429\b|quota/i.test(message)) return '服務目前限流或額度已用完，請稍後再試。';
  if (/NotAllowed|permission|denied/i.test(message))
    return '沒有麥克風權限。請在瀏覽器的網站設定中允許麥克風後再試。';
  if (/NotFound|no_audio|audio track/i.test(message)) return '找不到可用的麥克風。';
  if (/network|timed? ?out|\b50[234]\b|fetch/i.test(message))
    return '連不上服務，請檢查網路、權限或瀏覽器跨來源限制後再試。';
  return `無法開始：${message}`;
}

/** Everything still in memory, oldest first: translation, then the original under it. */
export function transcriptText(
  segments: CaptionSegment[],
  translations: Record<string, CaptionTranslation>,
  bilingual: boolean,
): string {
  return segments
    .map((segment) => {
      const target = translations[segment.segmentId]?.targetText;
      if (!target) return segment.text;
      return bilingual && segment.text ? `${target}\n${segment.text}` : target;
    })
    .filter(Boolean)
    .join('\n\n');
}

// ─── Settings sheet ──────────────────────────────────────────────────────────

type KeyCheck = { tone: 'ok' | 'bad' | 'wait'; text: string };

/**
 * Ask the provider for a short-lived session credential with the saved key.
 * Costs nothing (no audio is sent) and is the same request Start makes, so a
 * pass here means the key works from this phone and this network.
 */
async function checkKey(provider: DeviceKeyProvider): Promise<KeyCheck> {
  try {
    const res = await deviceBrokerFetch(provider === 'gemini' ? '/session/gemini' : '/session', {
      method: 'POST',
      body: '{}',
    });
    if (res.ok) return { tone: 'ok', text: '測試通過，可以使用。' };
    // Google answers an unknown key with 400, OpenAI with 401.
    if (res.status === 400 || res.status === 401 || res.status === 403)
      return { tone: 'bad', text: '金鑰被拒絕：請確認是否貼錯、已停用，或有 IP／用途限制。' };
    if (res.status === 429) return { tone: 'bad', text: '金鑰有效，但目前額度或頻率受限。' };
    if (res.status === 504) return { tone: 'bad', text: '服務沒有回應，請稍後再測試。' };
    return { tone: 'bad', text: `服務回應異常（${res.status}），請稍後再測試。` };
  } catch {
    return { tone: 'bad', text: '連不上服務：請檢查網路，或瀏覽器是否阻擋了連線。' };
  }
}

// Test results outlive the field that started them: the same key shows up on
// the first-run screen and in Settings, and both must agree.
let keyChecks: Partial<Record<DeviceKeyProvider, KeyCheck>> = {};
const keyCheckRuns: Record<DeviceKeyProvider, number> = { gemini: 0, openai: 0 };
const keyCheckListeners = new Set<() => void>();
function setKeyCheck(provider: DeviceKeyProvider, check: KeyCheck | null): void {
  const next = { ...keyChecks };
  if (check) next[provider] = check;
  else delete next[provider];
  keyChecks = next;
  keyCheckListeners.forEach((listener) => listener());
}
function useKeyChecks() {
  return useSyncExternalStore(
    (listener) => {
      keyCheckListeners.add(listener);
      return () => keyCheckListeners.delete(listener);
    },
    () => keyChecks,
    () => keyChecks,
  );
}
function runKeyCheck(provider: DeviceKeyProvider): void {
  const run = ++keyCheckRuns[provider];
  setKeyCheck(provider, { tone: 'wait', text: '測試中…' });
  void checkKey(provider).then((result) => {
    // A newer save/remove/test owns the status line.
    if (keyCheckRuns[provider] === run) setKeyCheck(provider, result);
  });
}
function forgetKey(provider: DeviceKeyProvider): void {
  keyCheckRuns[provider]++;
  setKeyCheck(provider, null);
  setDeviceKey(provider, '');
}

function KeyField({ provider }: { provider: (typeof PROVIDERS)[number] }) {
  const saved = useDeviceKeys()[provider.id];
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const check = useKeyChecks()[provider.id] ?? null;
  const runCheck = () => runKeyCheck(provider.id);
  return (
    <div className="m-key">
      <div className="m-key-head">
        <strong>{provider.label} 金鑰</strong>
        <span data-testid={`m-key-state-${provider.id}`}>
          {saved ? `已儲存 ${maskKey(saved)}` : '尚未設定'}
        </span>
      </div>
      <form
        className="m-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          const remembered = setDeviceKey(provider.id, draft);
          setDraft('');
          setNote(remembered ? null : '這個瀏覽器不允許儲存，關閉分頁後需要重新輸入。');
          runCheck();
        }}
      >
        <input
          type="password"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={saved ? '貼上新金鑰以取代' : '貼上金鑰'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`${provider.label} 金鑰`}
          data-testid={`m-key-input-${provider.id}`}
        />
        <button type="submit" disabled={!draft.trim()} data-testid={`m-key-save-${provider.id}`}>
          儲存
        </button>
        {saved && (
          <>
            <button type="button" onClick={runCheck} data-testid={`m-key-test-${provider.id}`}>
              測試
            </button>
            <button
              type="button"
              className="m-quiet"
              onClick={() => {
                if (!window.confirm(`移除這支手機上的 ${provider.label} 金鑰？`)) return;
                forgetKey(provider.id);
              }}
            >
              移除
            </button>
          </>
        )}
      </form>
      {check && (
        <p
          className="m-check"
          data-tone={check.tone}
          role="status"
          data-testid={`m-key-check-${provider.id}`}
        >
          {check.text}
        </p>
      )}
      <p className="m-hint">
        {provider.hint} 到{' '}
        <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
          {provider.keyHost}
        </a>{' '}
        取得。
      </p>
      {note && <p className="m-warn">{note}</p>}
    </div>
  );
}

function Settings({
  running,
  fontStep,
  setFontStep,
  onClose,
}: {
  running: boolean;
  fontStep: number;
  setFontStep: (step: number) => void;
  onClose: () => void;
}) {
  const keys = useDeviceKeys();
  const provider = useSettingsStore((s) => s.onlineProvider);
  const langPair = useSettingsStore((s) => s.langPair);
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  const micDistance = useSettingsStore((s) => s.micDistance);
  const set = settingsStore.getState();
  return (
    <div className="m-sheet-backdrop" onClick={onClose}>
      <section
        className="m-sheet"
        role="dialog"
        aria-label="設定"
        onClick={(event) => event.stopPropagation()}
        data-testid="m-settings"
      >
        <header>
          <h2>設定</h2>
          <button type="button" onClick={onClose} data-testid="m-settings-close">
            完成
          </button>
        </header>

        <h3>閱讀</h3>
        <div className="m-row">
          <span>字體大小</span>
          <div className="m-seg" role="group" aria-label="字體大小">
            {['小', '中', '大', '特大'].map((label, step) => (
              <button
                type="button"
                key={label}
                aria-pressed={fontStep === step}
                onClick={() => setFontStep(step)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="m-row">
          <span>同時顯示原文</span>
          <input
            type="checkbox"
            checked={bilingual}
            disabled={running}
            onChange={(event) => set.setIncludeSourceTranscript(event.target.checked)}
          />
        </label>

        <h3>翻譯{running && <small>（停止後才能更改）</small>}</h3>
        <label className="m-row">
          <span>方向</span>
          <select
            value={langPair}
            disabled={running}
            onChange={(event) => set.setLangPair(event.target.value as LangPair)}
          >
            <option value="en→zh-TW">英文 → 繁體中文</option>
            <option value="zh-TW→en">中文 → 英文</option>
          </select>
        </label>
        <label className="m-row">
          <span>服務</span>
          <select
            value={provider}
            disabled={running}
            onChange={(event) => set.setOnlineProvider(event.target.value as OnlineProvider)}
            data-testid="m-provider"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {keys[p.id] ? '' : '（未設定金鑰）'}
              </option>
            ))}
          </select>
        </label>
        <label className="m-row">
          <span>收音距離</span>
          <select
            value={micDistance}
            disabled={running}
            onChange={(event) => set.setMicDistance(event.target.value as MicDistance)}
          >
            <option value="meeting">會議室（多人）</option>
            <option value="close">手機靠近說話者</option>
            <option value="far">說話者較遠</option>
          </select>
        </label>

        <h3>金鑰</h3>
        {PROVIDERS.map((p) => (
          <KeyField key={p.id} provider={p} />
        ))}
        {(keys.gemini || keys.openai) && (
          <button
            type="button"
            className="m-quiet m-wide"
            disabled={running}
            onClick={() => {
              if (!window.confirm('清除這支手機上儲存的所有金鑰？')) return;
              forgetKey('gemini');
              forgetKey('openai');
            }}
          >
            清除這支手機上的所有金鑰
          </button>
        )}
        <p className="m-hint">
          金鑰只存在這支手機的瀏覽器，只會送往對應的 Google／OpenAI
          服務以取得短效連線憑證，不經過其他伺服器。建議在供應商後台設定用量上限。字幕只留在記憶體，關閉分頁即清除。
        </p>
      </section>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export function MobileApp() {
  const gemini = useGeminiLive(undefined, MOBILE_PROVIDER_OPTIONS);
  const openai = useOpenAIRealtime(undefined, MOBILE_PROVIDER_OPTIONS);
  const keys = useDeviceKeys();
  const provider = useSettingsStore((s) => s.onlineProvider);
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  const transportHealth = useSettingsStore((s) => s.health.transport);
  const audioHealth = useSettingsStore((s) => s.health.audio);
  const transport = transportHealth.state;
  const audio = audioHealth.state;
  const hasText = useCaptionStore((s) => s.segments.length > 0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fontStep, setFontStepState] = useState(readFontStep);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Monotonic start token: pressing Stop mid-startup cancels any pending
  // fallback provider attempt so Stop never revives capture.
  const startRunRef = useRef(0);
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  // First run stays on the key screen until the user moves on, so the result of
  // the key test is seen instead of being replaced by an empty caption view.
  const [onboarding, setOnboarding] = useState(
    () => !getDeviceKeys().gemini && !getDeviceKeys().openai,
  );
  const checks = useKeyChecks();

  const running = gemini.status === 'running' || openai.status === 'running';
  const hasAnyKey = Boolean(keys.gemini || keys.openai);
  const otherProvider: DeviceKeyProvider = provider === 'gemini' ? 'openai' : 'gemini';
  const hasOtherKey = Boolean(keys[otherProvider]);
  const error = running || starting ? (provider === 'gemini' ? gemini.error : openai.error) : null;
  const lastError = fatalError ?? (provider === 'gemini' ? gemini.error : openai.error);
  useWakeLock(running);

  // Track browser online/offline state so the user immediately sees network drops.
  useEffect(() => {
    const onOffline = () => setOffline(true);
    const onOnline = () => setOffline(false);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // Guard against accidental refresh/tab close while captions exist in memory.
  useEffect(() => {
    if (!running && !hasText) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [running, hasText]);

  // Auto-dismiss transient confirmation notices (keep in-progress "…" notices).
  useEffect(() => {
    if (!notice || notice.endsWith('…')) return undefined;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // If a running provider hits a permanent refusal (e.g. 401/403/400), stop it
  // instead of leaving the UI stuck on "連線中斷，重試中".
  const stopOpenAI = openai.stop;
  const stopGemini = gemini.stop;
  const currentError = provider === 'gemini' ? gemini.error : openai.error;
  useEffect(() => {
    if (!running || starting) return;
    const failure = transportHealth.recoveryFailure;
    if (!permanentRecoveryFailure(failure) || failure?.provider !== provider) return;
    const message = transportHealth.message ?? currentError ?? 'auth';
    setFatalError(message);
    stopOpenAI();
    stopGemini();
  }, [running, starting, transportHealth, provider, currentError, stopOpenAI, stopGemini]);

  // The phone build is microphone-only online translation. Normalise settings
  // once so a value left by another build can never select an absent path.
  useEffect(() => {
    const state = settingsStore.getState();
    if (state.modeId !== 'online_full') state.setMode('online_full');
    if (state.audioSource !== 'mic') state.setAudioSource('mic');
    if (state.captionTask.purpose !== 'translation') state.setLangPair(state.langPair);
  }, []);

  // Follow the keys: never leave the selection on a provider with no key.
  useEffect(() => {
    if (running || keys[provider]) return;
    const other = provider === 'gemini' ? 'openai' : 'gemini';
    if (keys[other]) settingsStore.getState().setOnlineProvider(other);
  }, [keys, provider, running]);

  const setFontStep = useCallback((step: number) => {
    setFontStepState(step);
    try {
      localStorage.setItem(FONT_KEY, String(step));
    } catch {
      /* not remembered; still applied */
    }
  }, []);

  const start = async (preferredOverride?: DeviceKeyProvider) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setFatalError('network');
      return;
    }
    const preferred = preferredOverride ?? settingsStore.getState().onlineProvider;
    const order = resolveStartOrder(preferred, getDeviceKeys());
    if (order.length === 0) {
      setSettingsOpen(true);
      return;
    }
    const run = ++startRunRef.current;
    setNotice(null);
    setFatalError(null);
    setStarting(true);
    try {
      for (let idx = 0; idx < order.length; idx++) {
        if (startRunRef.current !== run) return;
        const backend = order[idx]!;
        if (settingsStore.getState().onlineProvider !== backend) {
          settingsStore.getState().setOnlineProvider(backend);
        }
        // A manual Start is a fresh attempt: forget an earlier permanent refusal
        // (for example a key that has since been replaced or a Wi-Fi change).
        clearRecoveryRefusal(backend, 'translation');
        const peer = backend === 'gemini' ? openai : gemini;
        peer.stop();
        const mode = backend === 'gemini' ? 'gemini' : 'real';
        const captions = captionStore.getState();
        if (captions.sessionId && captions.segments.length > 0) {
          // Text is still on screen: continue under it. Only 「清除」 discards it.
          captionStore.setState({ sessionEndedAt: null });
          captions.setSessionMode(mode);
          captions.setSessionPhase('running');
        } else {
          captions.beginSession(mode, settingsStore.getState().captionTask, false);
        }
        const ok = await (backend === 'gemini' ? gemini.start() : openai.start());
        if (startRunRef.current !== run) return;
        if (ok) {
          if (idx > 0) {
            const firstLabel = order[0] === 'openai' ? 'OpenAI' : 'Gemini';
            const usedLabel = backend === 'openai' ? 'OpenAI' : 'Gemini';
            setNotice(`${firstLabel} 無法使用，已自動改用 ${usedLabel}。`);
          }
          return;
        }
        // If local microphone failed, switching cloud provider cannot help.
        const currentAudio = settingsStore.getState().health.audio.state;
        if (currentAudio === 'failed' || currentAudio === 'no_audio_track') return;
        if (idx + 1 < order.length) {
          const nextLabel = order[idx + 1] === 'openai' ? 'OpenAI' : 'Gemini';
          setNotice(
            `${backend === 'openai' ? 'OpenAI' : 'Gemini'} 無法連線，嘗試改用 ${nextLabel}…`,
          );
        }
      }
    } finally {
      if (startRunRef.current === run) setStarting(false);
    }
  };

  const stop = () => {
    startRunRef.current += 1;
    setStarting(false);
    setFatalError(null);
    openai.stop();
    gemini.stop();
    captionStore.getState().endSession();
  };

  const resumeSuspendedAudio = async () => {
    try {
      await resumeCaptureContext();
      setNotice('已恢復收音');
    } catch {
      setNotice('無法恢復收音，請按「停止」後重新開始。');
    }
  };

  const fullText = () => {
    const state = captionStore.getState();
    return transcriptText(state.segments, state.translations, bilingual);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullText());
      setNotice('已複製全文');
    } catch {
      setNotice('無法複製，請改用「下載」或「分享」。');
    }
  };
  const downloadTxt = () => {
    const content = fullText();
    if (!content) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `captions-${stamp}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已下載文字檔');
  };
  const share = async () => {
    try {
      await navigator.share({ text: fullText() });
    } catch {
      /* user dismissed the share sheet */
    }
  };
  const clear = () => {
    if (window.confirm('清除目前畫面上的字幕？此動作無法復原。')) {
      captionStore.getState().clear();
      setNotice(null);
    }
  };

  const [tone, label] = statusLabel(running, transport, audio, offline);
  const canShare = typeof navigator.share === 'function';
  const showResumeAudio =
    running && audio === 'degraded' && audioHealth.reason === 'context_suspended';
  const activeError = error || (!running && !starting && lastError);

  return (
    <div
      className="m-app"
      style={{ '--m-size': `${FONT_STEPS[fontStep]}rem` } as React.CSSProperties}
    >
      <header className="m-top">
        <span className="m-status" data-tone={tone} role="status" data-testid="m-status">
          <i aria-hidden="true" />
          {label}
          <AudioPulse active={running && transport === 'connected' && audio !== 'silence_detected'} />
        </span>
        <button
          type="button"
          className="m-icon"
          onClick={() => setSettingsOpen(true)}
          aria-label="設定"
          data-testid="m-open-settings"
        >
          設定
        </button>
      </header>

      {showResumeAudio && (
        <button
          type="button"
          className="m-resume-banner"
          onClick={() => void resumeSuspendedAudio()}
          data-testid="m-resume-audio"
        >
          收音因切換畫面或鎖屏暫停 — 點此恢復收音
        </button>
      )}

      {activeError && (
        <div className="m-alert" role="alert" data-testid="m-error">
          <span>{friendlyError(error ?? lastError ?? '')}</span>
          {!running && !starting && hasOtherKey && (
            <button
              type="button"
              className="m-switch-btn"
              onClick={() => void start(otherProvider)}
              data-testid="m-switch-provider"
            >
              改用 {otherProvider === 'gemini' ? 'Gemini' : 'OpenAI'}
            </button>
          )}
        </div>
      )}

      {hasAnyKey && !onboarding ? (
        <Reader running={running} fontStep={fontStep} />
      ) : (
        <main className="m-reader m-onboard" data-testid="m-onboard">
          <h1>即時翻譯字幕</h1>
          <p>手機聽現場的英文，直接顯示繁體中文字幕。第一次使用只要貼上一把金鑰。</p>
          <KeyField provider={PROVIDERS[0]!} />
          <details>
            <summary>改用 OpenAI 金鑰</summary>
            <KeyField provider={PROVIDERS[1]!} />
          </details>
          <p className="m-hint">金鑰只存在這支手機的瀏覽器，不會上傳到這個網站或任何其他伺服器。</p>
          {hasAnyKey && (
            <button
              type="button"
              className="m-main m-wide"
              onClick={() => setOnboarding(false)}
              data-testid="m-onboard-done"
            >
              開始使用
            </button>
          )}
        </main>
      )}

      {notice && (
        <p className="m-toast" role="status">
          {notice}
        </p>
      )}

      {hasAnyKey && !onboarding && !running && checks[provider]?.tone === 'bad' && (
        <p className="m-alert" role="alert" data-testid="m-key-problem">
          {provider === 'gemini' ? 'Gemini' : 'OpenAI'} 金鑰測試未通過：{checks[provider]?.text}
          請到「設定」更換金鑰。
        </p>
      )}

      {hasAnyKey && !onboarding && (
        <footer className="m-bar">
          {!running && hasText && (
            <div className="m-actions">
              <button type="button" onClick={() => void copy()} data-testid="m-copy">
                複製全文
              </button>
              <button type="button" onClick={downloadTxt} data-testid="m-download">
                下載
              </button>
              {canShare && (
                <button type="button" onClick={() => void share()}>
                  分享
                </button>
              )}
              <button type="button" className="m-quiet" onClick={clear}>
                清除
              </button>
            </div>
          )}
          {running ? (
            <button type="button" className="m-main m-stop" onClick={stop} data-testid="m-stop">
              停止
            </button>
          ) : (
            <button
              type="button"
              className="m-main"
              onClick={() => void start()}
              disabled={starting}
              data-testid="m-start"
            >
              {starting ? '啟動中…' : hasText ? '繼續' : '開始'}
            </button>
          )}
        </footer>
      )}

      {settingsOpen && (
        <Settings
          running={running}
          fontStep={fontStep}
          setFontStep={setFontStep}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
