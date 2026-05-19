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
import { useFakeReplay } from './providers/use-fake-replay.js';
import { useSettingsStore } from './settings/use-settings-store.js';
import { captionStore } from './store/use-caption-store.js';
import { IS_ONLINE_ONLY } from './deployment.js';

export function App() {
  const fake = useFakeReplay();
  const realtime = useOpenAIRealtime();
  const offline = useOfflineSTT();
  const modeId = useSettingsStore((s) => s.modeId);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const includeSourceTranscript = useSettingsStore((s) => s.includeSourceTranscript);
  const micDistance = useSettingsStore((s) => s.micDistance);
  const startSession = useSettingsStore((s) => s.startSession);
  const stopSession = useSettingsStore((s) => s.stopSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Forwarded to SettingsPanel so its outside-click detector knows to
  // ignore clicks on the ⚙ toggle itself (otherwise close+reopen race).
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  const isRunning =
    fake.status === 'running' || realtime.status === 'running' || offline.status === 'running';
  const activeError = fake.error ?? realtime.error ?? offline.error;

  const handleStartFake = () => {
    realtime.stop();
    offline.stop();
    // Reset caption store to a fresh session — without this, fake-replay
    // events would append into any restored history with timestamps anchored
    // to the previous sessionStartMs. beginSession() also clears the
    // restoredFromStorage flag so the 📂 chip dismisses.
    captionStore.getState().beginSession();
    void fake.start();
  };

  const handleStartReal = useCallback(async () => {
    fake.stop();
    offline.stop();
    // Always drain any in-flight session into the cost accumulators before
    // starting anew. stopSession() is idempotent (no-op when sessionStartAt
    // is null), so this is safe for both the cold-start and the auto-
    // restart-on-toggle-change paths. Without this drain, the
    // toggle-triggered restart would overwrite sessionStartAt and lose
    // the accumulated minutes from the pre-toggle interval.
    stopSession();
    // Reset caption store ONLY when there is no active session in flight.
    // handleStartReal is also called by the mid-session auto-restart
    // (includeSourceTranscript / micDistance toggle) — that path needs to
    // preserve segments because the meeting itself is continuing; only the
    // upstream connection is being recycled. Detection: an "active" session
    // is one where beginSession() ran and endSession() has not — i.e.,
    // sessionId !== null && sessionEndedAt === null. In all other cases
    // (cold start, restored-from-storage, post-Stop restart) the user is
    // beginning fresh work and the restored chip + stale segments should
    // be cleared.
    const cs = captionStore.getState();
    const sessionActive = cs.sessionId !== null && cs.sessionEndedAt === null;
    if (!sessionActive) cs.beginSession();
    // Start the cost timer ONLY after the realtime provider reaches the
    // 'running' state. If start() fails (mic denied, /session error, SDP
    // exchange refused), it returns false and we never accrue billed time
    // for a session that never connected — the inflated-elapsed-total bug
    // Codex flagged.
    const ok = await realtime.start();
    if (ok) startSession();
  }, [fake, offline, realtime, startSession, stopSession]);

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
  useEffect(() => {
    const sourceChanged = prevIncludeSourceRef.current !== includeSourceTranscript;
    const micChanged = prevMicDistanceRef.current !== micDistance;
    if (sourceChanged) prevIncludeSourceRef.current = includeSourceTranscript;
    if (micChanged) prevMicDistanceRef.current = micDistance;
    if ((sourceChanged || micChanged) && realtime.status === 'running') {
      // Either change requires a fresh /session POST (transcription model
      // and noise_reduction profile are fixed at session creation) AND a
      // fresh getUserMedia (AGC is fixed at track creation). Auto-restart
      // covers both. The reconnecting pill on the caption board surfaces
      // the brief gap.
      void handleStartReal();
    }
  }, [includeSourceTranscript, micDistance, realtime.status, handleStartReal]);

  const handleStartOffline = () => {
    fake.stop();
    realtime.stop();
    captionStore.getState().beginSession();
    void offline.start();
  };

  const handleStop = () => {
    if (fake.status === 'running') fake.stop();
    if (realtime.status === 'running') { realtime.stop(); stopSession(); }
    if (offline.status === 'running') offline.stop();
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
  const offlineButtonTitle = !offline.hasWhisper
    ? `WhisperLive: ${offline.whisperStatus ?? 'checking…'}`
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
            realtime.status === 'running' ? 'running' : 'idle'
          }>
            {fake.status === 'running' ? 'fake' :
             offline.status === 'running' ? 'offline' :
             realtime.status === 'running' ? realtime.status : 'idle'}
          </span>
          {!IS_ONLINE_ONLY && (
            <span
              className="audio-source-chip"
              title={audioSource === 'system' ? 'System audio (WASAPI)' : 'Microphone'}
            >
              {audioSource === 'system' ? '🔊' : '🎤'}
            </span>
          )}
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
              disabled
              title="Hybrid Privacy — local STT + online translation, coming in P4"
              data-testid="start-hybrid"
            >
              🔀 Hybrid (P4)
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
              {offline.hasWhisper ? '🖥 Start Offline' : `🖥 Whisper: ${offline.whisperStatus ?? '…'}`}
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

      <CaptionBoard />
    </main>
  );
}
