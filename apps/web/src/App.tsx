import { useState } from 'react';
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { useOpenAIRealtime } from './providers/use-openai-realtime.js';
import { useFakeReplay } from './providers/use-fake-replay.js';
import { useSettingsStore } from './settings/use-settings-store.js';

export function App() {
  const fake = useFakeReplay();
  const realtime = useOpenAIRealtime();
  const modeId = useSettingsStore((s) => s.modeId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isRunning = fake.status === 'running' || realtime.status === 'running';
  const activeError = fake.error ?? realtime.error;

  const handleStartFake = () => {
    realtime.stop();
    void fake.start();
  };

  const handleStartReal = () => {
    fake.stop();
    void realtime.start();
  };

  const handleStop = () => {
    fake.stop();
    realtime.stop();
  };

  const showRealButton = modeId === 'online_full';
  const realButtonDisabled = realtime.hasApiKey === false || isRunning;
  const realButtonTitle =
    realtime.hasApiKey === false
      ? 'OPENAI_API_KEY not configured on server'
      : realtime.hasApiKey === null
        ? 'Checking API key…'
        : undefined;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Meeting Audio</h1>
          <p className="app-subtitle">P2 — OpenAI Realtime mic path</p>
        </div>
        <div className="app-controls">
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
