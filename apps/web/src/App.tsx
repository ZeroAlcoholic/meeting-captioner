import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { RealtimePricingPanel } from './components/RealtimePricingPanel.js';
import { MicLevelBar } from './components/MicLevelBar.js';
import { StartRealButton } from './components/StartRealButton.js';
import { ExportMenu } from './components/ExportMenu.js';
import { RestoredSessionChip } from './components/RestoredSessionChip.js';
import { useOpenAIRealtime } from './providers/use-openai-realtime.js';
import { useOfflineSTT } from './providers/use-offline-stt.js';
import { useHybridMode } from './providers/use-hybrid-mode.js';
import { useFakeReplay } from './providers/use-fake-replay.js';
import { useSettingsStore } from './settings/use-settings-store.js';
import { captionStore } from './store/use-caption-store.js';
import { IS_ONLINE_ONLY } from './deployment.js';

export function App() {
  const fake = useFakeReplay();
  const realtime = useOpenAIRealtime();
  const offline = useOfflineSTT();
  const hybrid = useHybridMode();
  const modeId = useSettingsStore((s) => s.modeId);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const setAudioSource = useSettingsStore((s) => s.setAudioSource);
  const includeSourceTranscript = useSettingsStore((s) => s.includeSourceTranscript);
  const micDistance = useSettingsStore((s) => s.micDistance);
  const startSession = useSettingsStore((s) => s.startSession);
  const stopSession = useSettingsStore((s) => s.stopSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Forwarded to SettingsPanel so its outside-click detector knows to
  // ignore clicks on the ⚙ toggle itself (otherwise close+reopen race).
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  const isRunning =
    fake.status === 'running' || realtime.status === 'running' || offline.status === 'running' || hybrid.status === 'running';
  const activeError = fake.error ?? realtime.error ?? offline.error ?? hybrid.error;

  const handleStartFake = () => {
    realtime.stop();
    offline.stop();
    hybrid.stop();
    // Reset caption store to a fresh session — without this, fake-replay
    // events would append into any restored history with timestamps anchored
    // to the previous sessionStartMs. beginSession() also clears the
    // restoredFromStorage flag so the 📂 chip dismisses.
    captionStore.getState().beginSession();
    void fake.start();
  };

  const handleStartReal = useCallback(async (): Promise<boolean> => {
    fake.stop();
    offline.stop();
    hybrid.stop();
    // Always drain any in-flight session into the cost accumulators before
    // starting anew. stopSession() is idempotent (no-op when sessionStartAt
    // is null), so this is safe for both the cold-start and the auto-
    // restart-on-toggle-change paths. Without this drain, the
    // toggle-triggered restart would overwrite sessionStartAt and lose
    // the accumulated minutes from the pre-toggle interval.
    stopSession();
    // Reset caption store unless this is the auto-restart path triggered
    // by a mid-session toggle change. The signal "are we currently running
    // a real session?" must come from in-memory realtime.status, NOT from
    // persisted captionStore fields — captionStore.sessionId / sessionEndedAt
    // survive a tab reload, so a cold-reload-then-Start would otherwise
    // be mistaken for an in-flight restart and skip beginSession(), causing
    // new transcript events to append onto the previous session's
    // timestamps. realtime.status === 'running' is true only when the
    // OpenAI provider is live in *this* tab session, which is exactly the
    // restart-vs-fresh-start distinction we need.
    const isAutoRestart = realtime.status === 'running';
    if (!isAutoRestart) captionStore.getState().beginSession();
    // Start the cost timer ONLY after the realtime provider reaches the
    // 'running' state. If start() fails (mic denied, /session error, SDP
    // exchange refused), it returns false and we never accrue billed time
    // for a session that never connected — the inflated-elapsed-total bug
    // Codex flagged.
    const ok = await realtime.start();
    if (ok) startSession();
    return ok;
  }, [fake, offline, hybrid, realtime, startSession, stopSession]);

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

  const handleStartOffline = () => {
    fake.stop();
    realtime.stop();
    hybrid.stop();
    captionStore.getState().beginSession();
    void offline.start();
  };

  const handleStartHybrid = () => {
    fake.stop();
    realtime.stop();
    offline.stop();
    captionStore.getState().beginSession();
    void hybrid.start();
  };

  const handleStop = () => {
    if (fake.status === 'running') fake.stop();
    if (realtime.status === 'running') { realtime.stop(); stopSession(); }
    if (offline.status === 'running') offline.stop();
    if (hybrid.status === 'running') hybrid.stop();
    // Mark the session as cleanly ended. Data stays in memory + persisted so
    // the user can still hit Export after Stop — endSession() is a metadata
    // flag, not a clear.
    captionStore.getState().endSession();
  };

  // In the online-slim distribution, hybrid/offline modes are filtered out of
  // MODE_OPTIONS so modeId can only ever be 'online_full'. Guard with the
  // build flag rather than runtime probing — keeps the React tree predictable.
  const showRealButton = IS_ONLINE_ONLY || modeId === 'online_full';
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
            realtime.status === 'running' ? 'running' : 'idle'
          }>
            {fake.status === 'running' ? 'fake' :
             offline.status === 'running' ? 'offline' :
             hybrid.status === 'running' ? 'hybrid' :
             realtime.status === 'running' ? realtime.status : 'idle'}
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
            disabled={isRunning}
            data-testid="start-fake-replay"
            title="Replay scripted captions — no audio required"
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
          <button
            type="button"
            onClick={handleStop}
            disabled={!isRunning}
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
