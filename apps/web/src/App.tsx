import { useState } from 'react';

function formatEta(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { RealtimePricingPanel } from './components/RealtimePricingPanel.js';
import { rmsToWidthPercent } from './components/AudioLevelMeter.js';
import { useOpenAIRealtime } from './providers/use-openai-realtime.js';
import { useOfflineSTT } from './providers/use-offline-stt.js';
import { useFakeReplay } from './providers/use-fake-replay.js';
import { useSettingsStore } from './settings/use-settings-store.js';

export function App() {
  const fake = useFakeReplay();
  const realtime = useOpenAIRealtime();
  const offline = useOfflineSTT();
  const modeId = useSettingsStore((s) => s.modeId);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const audioLevel = useSettingsStore((s) => s.audioLevel);
  const audioState = useSettingsStore((s) => s.health.audio.state);
  const startSession = useSettingsStore((s) => s.startSession);
  const stopSession = useSettingsStore((s) => s.stopSession);
  const [settingsOpen, setSettingsOpen]   = useState(false);

  const isRunning =
    fake.status === 'running' || realtime.status === 'running' || offline.status === 'running';
  const activeError = fake.error ?? realtime.error ?? offline.error;

  const handleStartFake = () => {
    realtime.stop();
    offline.stop();
    void fake.start();
  };

  const handleStartReal = () => {
    fake.stop();
    offline.stop();
    startSession();
    void realtime.start();
  };

  const handleStartOffline = () => {
    fake.stop();
    realtime.stop();
    void offline.start();
  };

  const handleStop = () => {
    if (fake.status === 'running') fake.stop();
    if (realtime.status === 'running') { realtime.stop(); stopSession(); }
    if (offline.status === 'running') offline.stop();
  };

  const showRealButton = modeId === 'online_full';
  const showHybridButton = modeId === 'hybrid_privacy';
  const realButtonDisabled = realtime.apiKeyStatus !== 'present' || isRunning;
  const renewalTitle =
    realtime.status === 'running' && realtime.renewalEtaMs !== null
      ? ` — Auto-renew in ${formatEta(realtime.renewalEtaMs)}`
      : '';
  const realButtonTitle: string | undefined = {
    checking:       'Checking online service…',
    present:        renewalTitle ? `Online ready${renewalTitle}` : undefined,
    'no-key':       'OPENAI_API_KEY not configured on server',
    'service-down': 'Online service unreachable on :8787 — start it via start-dev.bat',
  }[realtime.apiKeyStatus];
  const realButtonLabel = {
    checking:       '🎤 Checking…',
    present:        '🎤 Start Real',
    'no-key':       '🔑 No API Key',
    'service-down': '⚠ Online Service Down',
  }[realtime.apiKeyStatus];

  const showOfflineButton = modeId === 'full_offline';
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
          {isRunning && (
            <div className="mic-level" data-state={audioState} title={`Mic: ${audioState}`}>
              <span className="mic-icon">🎤</span>
              <div className="mic-bar-wrap">
                <div
                  className="mic-bar-fill"
                  style={{ width: `${audioLevel ? rmsToWidthPercent(audioLevel.rmsDb) : 0}%` }}
                />
                {audioLevel && (
                  <div
                    className="mic-bar-peak"
                    style={{ left: `${rmsToWidthPercent(audioLevel.peakDb)}%` }}
                  />
                )}
              </div>
              {audioState !== 'idle' && audioState !== 'stopped' && (
                <span className="mic-state">{audioState}</span>
              )}
            </div>
          )}
          <span className="app-status" data-status={
            fake.status === 'running' ? 'running' :
            offline.status === 'running' ? 'running' :
            realtime.status === 'running' ? 'running' : 'idle'
          }>
            {fake.status === 'running' ? 'fake' :
             offline.status === 'running' ? 'offline' :
             realtime.status === 'running' ? realtime.status : 'idle'}
          </span>
          <span className="audio-source-chip" title={audioSource === 'system' ? 'System audio (WASAPI)' : 'Microphone'}>
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
            <button
              type="button"
              onClick={handleStartReal}
              disabled={realButtonDisabled}
              title={realButtonTitle}
              data-testid="start-real"
            >
              {realButtonLabel}
            </button>
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
          <button
            type="button"
            onClick={handleStop}
            disabled={!isRunning}
            data-testid="stop-fake-replay"
          >
            Stop
          </button>
          <button
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

      <SettingsPanel open={settingsOpen} />

      {activeError && (
        <div className="app-error" role="alert">
          <span>{activeError}</span>
          {realtime.error && realtime.apiKeyStatus === 'present' && (
            <button
              type="button"
              className="app-error-retry"
              onClick={() => realtime.retry()}
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
