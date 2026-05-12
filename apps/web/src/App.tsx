import { useState } from 'react';
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
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
  const audioLevel = useSettingsStore((s) => s.audioLevel);
  const audioState = useSettingsStore((s) => s.health.audio.state);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    void realtime.start();
  };

  const handleStartOffline = () => {
    fake.stop();
    realtime.stop();
    void offline.start();
  };

  const handleStop = () => {
    fake.stop();
    realtime.stop();
    offline.stop();
  };

  const showRealButton = modeId === 'online_full';
  const realButtonDisabled = realtime.hasApiKey === false || isRunning;
  const realButtonTitle =
    realtime.hasApiKey === false
      ? 'OPENAI_API_KEY not configured on server'
      : realtime.hasApiKey === null
        ? 'Checking API key…'
        : undefined;

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
          <p className="app-subtitle">P2 — OpenAI Realtime mic path</p>
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
              <span className="mic-state">{audioState}</span>
            </div>
          )}
          <span className="app-status" data-status={fake.status === 'running' ? 'running' : realtime.status}>
            {fake.status === 'running' ? 'fake' : realtime.status}
          </span>
          <button
            type="button"
            onClick={handleStartFake}
            disabled={isRunning}
            data-testid="start-fake-replay"
          >
            Start Fake Replay
          </button>
          {showRealButton && (
            <button
              type="button"
              onClick={handleStartReal}
              disabled={realButtonDisabled}
              title={realButtonTitle}
              data-testid="start-real"
            >
              {realtime.hasApiKey === false ? '🎤 No API Key' : '🎤 Start Real'}
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
          {activeError}
        </div>
      )}

      <CaptionBoard />
    </main>
  );
}
