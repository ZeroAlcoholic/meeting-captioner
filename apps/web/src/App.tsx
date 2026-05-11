import { useState } from 'react';
import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { useFakeReplay } from './providers/use-fake-replay.js';

export function App() {
  const { status, error, start, stop } = useFakeReplay();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Meeting Audio</h1>
          <p className="app-subtitle">P1 — scenario / mode / health UI shell</p>
        </div>
        <div className="app-controls">
          <span className="app-status" data-status={status}>
            {status}
          </span>
          <button
            type="button"
            onClick={start}
            disabled={status === 'running'}
            data-testid="start-fake-replay"
          >
            Start Fake Replay
          </button>
          <button
            type="button"
            onClick={stop}
            disabled={status !== 'running'}
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

      {error && (
        <div className="app-error" role="alert">
          {error}
        </div>
      )}

      <CaptionBoard />
    </main>
  );
}
