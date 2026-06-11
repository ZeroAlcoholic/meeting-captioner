import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { RealtimePricingPanel } from './components/RealtimePricingPanel.js';
import { MicLevelBar } from './components/MicLevelBar.js';
import { StartRealButton } from './components/StartRealButton.js';
import { ExportMenu } from './components/ExportMenu.js';
import { RestoredSessionChip } from './components/RestoredSessionChip.js';
import { useOpenAIRealtime } from './providers/use-openai-realtime.js';
import { useGeminiLive } from './providers/use-gemini-live.js';
import { useOfflineSTT } from './providers/use-offline-stt.js';
import { useHybridMode } from './providers/use-hybrid-mode.js';
import { useFakeReplay } from './providers/use-fake-replay.js';
import { useSettingsStore } from './settings/use-settings-store.js';
import { captionStore } from './store/use-caption-store.js';
import { IS_ONLINE_ONLY } from './deployment.js';

export function App() {
  const fake = useFakeReplay();
  const realtime = useOpenAIRealtime();
  const gemini = useGeminiLive();
  const offline = useOfflineSTT();
  const hybrid = useHybridMode();
  const modeId = useSettingsStore((s) => s.modeId);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const setAudioSource = useSettingsStore((s) => s.setAudioSource);
  const includeSourceTranscript = useSettingsStore((s) => s.includeSourceTranscript);
  const micDistance = useSettingsStore((s) => s.micDistance);
  const startSession = useSettingsStore((s) => s.startSession);
  const stopSession = useSettingsStore((s) => s.stopSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which provider was running when the user hit Pause. Non-null means a
  // session is paused: capture + billing are stopped but the transcript log
  // is preserved so Resume can continue the SAME session without clearing.
  const [pausedMode, setPausedMode] = useState<'fake' | 'real' | 'gemini' | 'offline' | 'hybrid' | null>(null);
  // Forwarded to SettingsPanel so its outside-click detector knows to
  // ignore clicks on the ⚙ toggle itself (otherwise close+reopen race).
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  const isRunning =
    fake.status === 'running' || realtime.status === 'running' || gemini.status === 'running' ||
    offline.status === 'running' || hybrid.status === 'running';
  const activeError = fake.error ?? realtime.error ?? gemini.error ?? offline.error ?? hybrid.error;

  const handleStartFake = () => {
    realtime.stop();
    gemini.stop();
    offline.stop();
    hybrid.stop();
    setPausedMode(null);
    // Reset caption store to a fresh session — without this, fake-replay
    // events would append into any restored history with timestamps anchored
    // to the previous sessionStartMs. beginSession() also clears the
    // restoredFromStorage flag so the 📂 chip dismisses.
    captionStore.getState().beginSession();
    void fake.start();
  };

  // Core real-session bring-up. `continueSession` skips beginSession() so the
  // existing transcript/history is preserved and new events append to it —
  // that's the Resume-after-Pause path. A fresh Start passes false.
  const startRealCore = useCallback(async (continueSession: boolean): Promise<boolean> => {
    fake.stop();
    gemini.stop();
    offline.stop();
    hybrid.stop();
    setPausedMode(null);
    // Always drain any in-flight session into the cost accumulators before
    // starting anew. stopSession() is idempotent (no-op when sessionStartAt
    // is null), so this is safe for both the cold-start and the auto-
    // restart-on-toggle-change paths. Without this drain, the
    // toggle-triggered restart would overwrite sessionStartAt and lose
    // the accumulated minutes from the pre-toggle interval.
    stopSession();
    // Reset caption store unless this is the auto-restart path triggered
    // by a mid-session toggle change, OR an explicit Resume. The signal "are
    // we currently running a real session?" must come from in-memory
    // realtime.status, NOT from persisted captionStore fields —
    // captionStore.sessionId / sessionEndedAt survive a tab reload, so a
    // cold-reload-then-Start would otherwise be mistaken for an in-flight
    // restart and skip beginSession(), causing new transcript events to
    // append onto the previous session's timestamps. realtime.status ===
    // 'running' is true only when the OpenAI provider is live in *this* tab
    // session, which is exactly the restart-vs-fresh-start distinction we need.
    const isAutoRestart = realtime.status === 'running';
    if (!isAutoRestart && !continueSession) captionStore.getState().beginSession();
    // Start the cost timer ONLY after the realtime provider reaches the
    // 'running' state. If start() fails (mic denied, /session error, SDP
    // exchange refused), it returns false and we never accrue billed time
    // for a session that never connected — the inflated-elapsed-total bug
    // Codex flagged.
    const ok = await realtime.start();
    if (ok) startSession();
    return ok;
  }, [fake, gemini, offline, hybrid, realtime, startSession, stopSession]);

  // Fresh start (clears history). Wrapped so the onClick MouseEvent never
  // leaks into startRealCore's boolean param.
  const handleStartReal = useCallback((): Promise<boolean> => startRealCore(false), [startRealCore]);

  // ─── Auto-restart on mid-session source-transcript toggle ─────────────────
  // The upstream OpenAI session config is fixed at /session creation, so a
  // mid-session toggle change would otherwise be silently ignored until the
  // user manually clicks Stop+Start. That's confusing — the toggle visibly
  // flips, the UI gate opens/closes, but the actual data stream doesn't
  // change. Detect the change while a real session is running and trigger
  // a fresh Stop+Start automatically. The existing reconnecting pill
  // covers the ~1-2 s visual gap.
  const prevIncludeSourceRef = useRef(includeSourceTranscript);
  const prevMicDistanceRef = useRef(micDistance);
  const prevAudioSourceRef = useRef(audioSource);
  useEffect(() => {
    const sourceChanged = prevIncludeSourceRef.current !== includeSourceTranscript;
    const micChanged = prevMicDistanceRef.current !== micDistance;
    const audioSourceChanged = prevAudioSourceRef.current !== audioSource;
    // Capture BEFORE updating refs so the failure-revert path below can
    // restore the user's previous selection rather than reading the
    // already-updated value.
    const previousAudioSource = prevAudioSourceRef.current;
    if (sourceChanged) prevIncludeSourceRef.current = includeSourceTranscript;
    if (micChanged) prevMicDistanceRef.current = micDistance;
    if (audioSourceChanged) prevAudioSourceRef.current = audioSource;
    if ((sourceChanged || micChanged || audioSourceChanged) && realtime.status === 'running') {
      // Any of these three requires a fresh start:
      //   - includeSourceTranscript / micDistance → fresh /session POST
      //     (transcription model + noise_reduction are fixed at session
      //     creation) AND fresh getUserMedia (AGC is fixed at track
      //     creation).
      //   - audioSource → switch between MicrophoneAudioProvider and
      //     DisplayMediaAudioProvider entirely. The user re-confirms the
      //     getDisplayMedia picker if they switch to 'system'.
      // The reconnecting pill on the caption board surfaces the brief gap.
      void handleStartReal().then((ok) => {
        // If the auto-restart failed AND the trigger was an audioSource
        // change, revert the UI selection so the visible chip/state matches
        // reality. Common case: user flips Mic → System, dismisses Chrome's
        // share picker → DisplayMediaAudioProvider throws → realtime falls
        // to idle. Without this, the 🔊 chip would stay shown even though
        // no system capture is live, and the next Start would re-trigger
        // the picker without any explanation. The ref was already pointed
        // at the new value above, so we update both the store and the ref
        // back to the previous value to prevent this effect from re-firing
        // when the store change propagates.
        if (!ok && audioSourceChanged) {
          prevAudioSourceRef.current = previousAudioSource;
          setAudioSource(previousAudioSource);
        }
      });
    }
  }, [
    includeSourceTranscript,
    micDistance,
    audioSource,
    realtime.status,
    handleStartReal,
    setAudioSource,
  ]);

  // Online realtime via Gemini Live (alternative backend to OpenAI). Fresh
  // start clears history; mirrors handleStartReal's exclusivity. Not billed via
  // the OpenAI cost panel.
  const handleStartGemini = () => {
    fake.stop();
    realtime.stop();
    offline.stop();
    hybrid.stop();
    setPausedMode(null);
    captionStore.getState().beginSession();
    void gemini.start();
  };

  const handleStartOffline = () => {
    fake.stop();
    realtime.stop();
    gemini.stop();
    hybrid.stop();
    setPausedMode(null);
    captionStore.getState().beginSession();
    void offline.start();
  };

  const handleStartHybrid = () => {
    fake.stop();
    realtime.stop();
    gemini.stop();
    offline.stop();
    setPausedMode(null);
    captionStore.getState().beginSession();
    void hybrid.start();
  };

  // ─── Pause / Resume ────────────────────────────────────────────────────────
  // Pause stops capture (and, for the billed online path, drains accrued
  // minutes) but does NOT clear or end the session — the transcript log stays
  // intact and persisted. Resume restarts the same provider WITHOUT
  // beginSession(), so new events append to the preserved history. This is the
  // "stop without losing the LOG" path the operator needs mid-meeting.
  const handlePause = () => {
    if (fake.status === 'running') { fake.stop(); setPausedMode('fake'); }
    else if (realtime.status === 'running') { realtime.stop(); stopSession(); setPausedMode('real'); }
    else if (gemini.status === 'running') { gemini.stop(); setPausedMode('gemini'); }
    else if (offline.status === 'running') { offline.stop(); setPausedMode('offline'); }
    else if (hybrid.status === 'running') { hybrid.stop(); setPausedMode('hybrid'); }
    // No beginSession() / clear() / endSession(): history is preserved for Resume.
  };

  const handleResume = () => {
    const m = pausedMode;
    setPausedMode(null);
    // Online providers resume into the CURRENTLY SELECTED backend, not
    // necessarily the one that was paused. This is the mid-meeting failover
    // path: backend degrades → Pause → switch OpenAI↔Gemini in Settings
    // (picker unlocks while paused) → Resume continues the SAME transcript
    // on the other backend. CLAUDE.md: provider switch must not clear the
    // transcript — neither resume path calls beginSession().
    if (m === 'real' || m === 'gemini') {
      if (onlineProvider === 'gemini') {
        fake.stop(); realtime.stop(); offline.stop(); hybrid.stop();
        void gemini.start();
      } else {
        void startRealCore(true);
      }
      return;
    }
    // Non-online providers: just re-start without beginSession() so new
    // segments append to the preserved log. Keep source exclusivity by
    // stopping the others first (mirrors the fresh-start handlers).
    if (m === 'offline') { fake.stop(); realtime.stop(); gemini.stop(); hybrid.stop(); void offline.start(); }
    else if (m === 'hybrid') { fake.stop(); realtime.stop(); gemini.stop(); offline.stop(); void hybrid.start(); }
    else if (m === 'fake') { realtime.stop(); gemini.stop(); offline.stop(); hybrid.stop(); void fake.start(); }
  };

  const handleStop = () => {
    if (fake.status === 'running') fake.stop();
    if (realtime.status === 'running') { realtime.stop(); stopSession(); }
    if (gemini.status === 'running') gemini.stop();
    if (offline.status === 'running') offline.stop();
    if (hybrid.status === 'running') hybrid.stop();
    setPausedMode(null);
    // Mark the session as cleanly ended. Data stays in memory + persisted so
    // the user can still hit Export after Stop — endSession() is a metadata
    // flag, not a clear.
    captionStore.getState().endSession();
  };

  // In the online-slim distribution, hybrid/offline modes are filtered out of
  // MODE_OPTIONS so modeId can only ever be 'online_full'. Guard with the
  // build flag rather than runtime probing — keeps the React tree predictable.
  // Online realtime backend is provider-selectable: OpenAI (WebRTC) or Gemini
  // (WebSocket). Both live under mode 'online_full'; the picker is in Settings.
  const isOnlineMode = IS_ONLINE_ONLY || modeId === 'online_full';
  const showRealButton = isOnlineMode && onlineProvider === 'openai';
  const showGeminiButton = isOnlineMode && onlineProvider === 'gemini';
  const showHybridButton = !IS_ONLINE_ONLY && modeId === 'hybrid_privacy';
  const showOfflineButton = !IS_ONLINE_ONLY && modeId === 'full_offline';

  const offlineButtonDisabled = !offline.hasWhisper || isRunning;
  const whisperLabel = (s: string | null) => {
    if (s === null) return 'checking…';
    if (s === 'model_loading') return 'loading model…';
    return s;
  };
  const offlineButtonTitle = !offline.hasWhisper
    ? `WhisperLive: ${whisperLabel(offline.whisperStatus)}`
    : undefined;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Meeting Audio</h1>
          <p className="app-subtitle">Live Caption &amp; Translation</p>
        </div>
        <div className="app-controls">
          <MicLevelBar visible={isRunning} />
          {!isRunning && <RestoredSessionChip />}
          <span className="app-status" data-status={
            fake.status === 'running' ? 'running' :
            offline.status === 'running' ? 'running' :
            hybrid.status === 'running' ? 'running' :
            gemini.status === 'running' ? 'running' :
            realtime.status === 'running' ? 'running' :
            pausedMode !== null ? 'paused' : 'idle'
          }>
            {fake.status === 'running' ? 'fake' :
             offline.status === 'running' ? 'offline' :
             hybrid.status === 'running' ? 'hybrid' :
             gemini.status === 'running' ? 'gemini' :
             // Name the backend (not the generic 'running') so the operator
             // can tell WHICH provider is live — matters after a mid-meeting
             // Pause → switch-backend → Resume failover.
             realtime.status === 'running' ? 'openai' :
             pausedMode !== null ? 'paused' : 'idle'}
          </span>
          {/* Audio-source chip is visible in both builds now — the Online
              path supports system audio via getDisplayMedia, so the
              indicator matters even in the slim distribution. The chip is
              an at-a-glance signal so a meeting operator can tell whether
              the next Start will pop the mic prompt or the screen-share
              picker without opening Settings. */}
          <span
            className="audio-source-chip"
            title={audioSource === 'system' ? 'System audio (display capture)' : 'Microphone'}
          >
            {audioSource === 'system' ? '🔊' : '🎤'}
          </span>
          {showRealButton && realtime.apiKeyStatus === 'present' && <RealtimePricingPanel />}
          <button
            type="button"
            onClick={handleStartFake}
            disabled={isRunning || pausedMode !== null}
            data-testid="start-fake-replay"
            title={pausedMode !== null
              ? '會議暫停中 — Demo 會清空目前字幕記錄，請先 Resume 或 Stop'
              : 'Replay scripted captions — no audio required'}
          >
            Demo
          </button>
          {showRealButton && (
            <StartRealButton
              apiKeyStatus={realtime.apiKeyStatus}
              running={realtime.status === 'running'}
              isOtherRunning={isRunning}
              onClick={handleStartReal}
              getRenewalEtaMs={realtime.getRenewalEtaMs}
            />
          )}
          {showGeminiButton && (
            <button
              type="button"
              onClick={handleStartGemini}
              disabled={!gemini.available || isRunning}
              title={
                gemini.geminiStatus === 'no-key'
                  ? 'GEMINI_API_KEY not configured on server'
                  : gemini.geminiStatus === 'service-down'
                    ? 'Online service unreachable'
                    : 'Gemini Live — realtime translation (繁體中文)'
              }
              data-testid="start-gemini"
            >
              {gemini.available
                ? '✦ Start Gemini'
                : gemini.geminiStatus === 'checking'
                  ? '✦ Gemini: checking…'
                  : gemini.geminiStatus === 'no-key'
                    ? '✦ Gemini: no key'
                    : '✦ Gemini: offline'}
            </button>
          )}
          {showHybridButton && (
            <button
              type="button"
              onClick={handleStartHybrid}
              disabled={!hybrid.hasWhisper || isRunning}
              title={!hybrid.hasWhisper
                ? `WhisperLive: ${whisperLabel(hybrid.whisperStatus)}`
                : 'Hybrid Privacy — local STT + online translation'}
              data-testid="start-hybrid"
            >
              {hybrid.hasWhisper ? '🔀 Start Hybrid' : `🔀 Whisper: ${whisperLabel(hybrid.whisperStatus)}`}
            </button>
          )}
          {showOfflineButton && (
            <button
              type="button"
              onClick={handleStartOffline}
              disabled={offlineButtonDisabled}
              title={offlineButtonTitle}
              data-testid="start-offline"
            >
              {offline.hasWhisper ? '🖥 Start Offline' : `🖥 Whisper: ${whisperLabel(offline.whisperStatus)}`}
            </button>
          )}
          <ExportMenu disabled={isRunning} />
          {isRunning && (
            <button
              type="button"
              onClick={handlePause}
              data-testid="pause-session"
              title="暫停擷取，保留字幕記錄（可隨後繼續，不會清空）"
            >
              ⏸ Pause
            </button>
          )}
          {!isRunning && pausedMode !== null && (
            <button
              type="button"
              onClick={handleResume}
              data-testid="resume-session"
              title="從暫停處繼續，沿用現有字幕記錄"
            >
              ▶ Resume
            </button>
          )}
          <button
            type="button"
            onClick={handleStop}
            disabled={!isRunning && pausedMode === null}
            data-testid="stop-fake-replay"
          >
            Stop
          </button>
          <button
            ref={settingsToggleRef}
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            data-testid="settings-toggle"
            aria-expanded={settingsOpen}
            aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
            className="settings-toggle"
            data-open={settingsOpen}
          >
            ⚙
          </button>
        </div>
      </header>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        triggerRef={settingsToggleRef}
        sessionActive={isRunning}
      />

      {activeError && (
        <div className="app-error" role="alert">
          <span>{activeError}</span>
          {realtime.error && realtime.apiKeyStatus === 'present' && (
            <button
              type="button"
              className="app-error-retry"
              onClick={handleStartReal}
              data-testid="retry-real"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {audioSource === 'system' && !isRunning && !activeError && (
        <div className="app-hint" role="note" data-testid="system-audio-hint">
          🔊 Share dialog tip: select <strong>Entire Screen</strong> → tick <strong>Share system audio</strong> → click Share
        </div>
      )}

      <CaptionBoard />
    </main>
  );
}
