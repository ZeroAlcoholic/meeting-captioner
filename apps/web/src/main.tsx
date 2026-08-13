import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './index.css';
import './providers/field-test-recorder.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found in index.html');

createRoot(rootElement).render(
  <StrictMode>
    {/* Last line of defence. If this fires the meeting is over, so it says so
        rather than leaving a white screen in front of the room. */}
    <ErrorBoundary
      testId="app-error-boundary"
      title="字幕系統發生錯誤"
      advice="這場會議的字幕已停止。請重新載入頁面重新開始；已保存的逐字稿不會遺失。"
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
