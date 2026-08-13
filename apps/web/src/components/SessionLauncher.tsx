import type { SessionMode } from '../store/caption-store.js';

/**
 * One launch choice in the start grid. Each option both selects its
 * configuration (mode/backend) AND starts capture in a single click, so the
 * operator never has to open Settings just to begin with a given setup.
 */
export interface LauncherOption {
  id: SessionMode;
  /** Big label, e.g. "OpenAI 即時翻譯". */
  label: string;
  /** One-line description shown under the label when available. */
  sublabel: string;
  icon: string;
  /** False → greyed out; `reason` explains why (no key, model loading, …). */
  available: boolean;
  reason?: string;
  onStart: () => void;
}

export interface SessionLauncherProps {
  options: LauncherOption[];
}

/**
 * Idle empty-state launcher: the easy on-ramp to start a meeting with any
 * configuration in one click. Rendered in place of the empty caption board when
 * nothing is running and there is no transcript yet.
 */
export function SessionLauncher({ options }: SessionLauncherProps) {
  return (
    <section className="launcher" data-testid="session-launcher">
      <div className="launcher-grid">
        <h2 className="launcher-heading">選擇模式，一鍵開始字幕</h2>
        <div className="launcher-options">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="launcher-option"
              disabled={!o.available}
              title={!o.available ? o.reason : o.sublabel}
              onClick={o.onStart}
              data-testid={`launch-${o.id}`}
            >
              <span className="launcher-option-icon">{o.icon}</span>
              <span className="launcher-option-label">{o.label}</span>
              <span className="launcher-option-sub">
                {o.available ? o.sublabel : (o.reason ?? '尚未就緒')}
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export interface ContinueBannerProps {
  /** Restored-but-unfinished session waiting to be resumed. */
  resumable: { count: number; label: string };
  onContinue: () => void;
}

/**
 * Slim bar shown ABOVE the restored transcript when a previous session was
 * interrupted (tab closed / crashed while running or paused). One click
 * continues the SAME backend, preserving the log — the crash-recovery path.
 */
export function ContinueBanner({ resumable, onContinue }: ContinueBannerProps) {
  return (
    <div className="continue-bar launcher-continue" role="note" data-testid="continue-banner">
      <div className="launcher-continue-text">
        <strong>上次會議未正常結束</strong>
        <span>
          {resumable.count} 段字幕已保留 · {resumable.label}
        </span>
      </div>
      <button
        type="button"
        className="launcher-continue-btn"
        onClick={onContinue}
        data-testid="continue-session"
      >
        ▶ 繼續上次會議
      </button>
    </div>
  );
}

export interface AutoSwitchNoticeProps {
  /** Backend that failed (e.g. "OpenAI"). */
  fromLabel: string;
  /** Backend the meeting was moved to (e.g. "Gemini"). */
  toLabel: string;
  onDismiss: () => void;
}

/**
 * Shown after the app moved the meeting to the other backend by itself.
 *
 * Silently changing which model produces the captions would be a lie of
 * omission — the operator would have no way to know that the text on the
 * projector is now coming from somewhere else, at different quality and
 * different cost. So the switch is always visible.
 *
 * It is a notice, not an alert: no role="alert", nothing to act on, dismissible.
 * The captions are already back; interrupting the meeting to announce that would
 * be its own kind of failure.
 */
export function AutoSwitchNotice({ fromLabel, toLabel, onDismiss }: AutoSwitchNoticeProps) {
  return (
    <div className="continue-bar autoswitch-bar" data-testid="autoswitch-notice">
      <div className="launcher-continue-text">
        <strong>
          {fromLabel} 中斷，已自動改用 {toLabel} 繼續
        </strong>
        {/* It used to say the failed backend was still retrying in the
            background. It is not: the handoff stops it, which cancels its retry
            loop. Switching back is a manual choice, so the notice says that
            instead of describing recovery that will not happen. */}
        <span>字幕記錄完整保留；{fromLabel} 已停止，可於設定中手動切回</span>
      </div>
      <button
        type="button"
        className="launcher-continue-btn"
        onClick={onDismiss}
        data-testid="autoswitch-dismiss"
      >
        知道了
      </button>
    </div>
  );
}

export interface FailoverBannerProps {
  /** Human label of the backend that is currently failing (e.g. "OpenAI"). */
  fromLabel: string;
  /** Human label of the backend we'd switch to (e.g. "Gemini"). */
  toLabel: string;
  /** Latest transport health message, surfaced as the sub-line when present. */
  message?: string | undefined;
  onFailover: () => void;
}

/**
 * Shown ABOVE the live board when the active online backend has entered its
 * 'failed' health state (auto-retry exhausted enough to surface it). The backend
 * keeps retrying on its own, but this gives the operator a one-click escape:
 * switch to the OTHER model and continue the SAME transcript — the cross-model
 * failover path (CLAUDE.md: a provider switch must not clear the transcript).
 */
export function FailoverBanner({ fromLabel, toLabel, message, onFailover }: FailoverBannerProps) {
  return (
    <div className="continue-bar failover-bar" role="alert" data-testid="failover-banner">
      <div className="launcher-continue-text">
        <strong>{fromLabel} 連線異常，仍在自動重試中</strong>
        <span>{message ?? '可一鍵切換到另一個後端，字幕記錄會完整保留'}</span>
      </div>
      <button
        type="button"
        className="launcher-continue-btn"
        onClick={onFailover}
        data-testid="failover-switch"
      >
        ⇄ 切換到 {toLabel} 繼續
      </button>
    </div>
  );
}
