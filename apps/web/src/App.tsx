import { CaptionBoard } from './caption-board/CaptionBoard.js';
import { useFakeReplay } from './providers/use-fake-replay.js';

export function App() {
  const { status, error, start, stop } = useFakeReplay();

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Meeting Audio</h1>
          <p className="app-subtitle">P0 — fake replay caption path</p>
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
        </div>
      </header>

      {error && (
        <div className="app-error" role="alert">
          {error}
        </div>
      )}

      <CaptionBoard />
    </main>
  );
}
