import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { installServiceFetch } from '../providers/service-fetch.js';
import { deviceBrokerFetch } from './device-broker.js';
import { MobileApp } from './MobileApp.js';
import './mobile.css';

// No server behind this build: session credentials are minted in the browser
// with the key saved on this device. Must run before any provider hook mounts.
installServiceFetch(deviceBrokerFetch);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found in mobile.html');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary
      testId="app-error-boundary"
      title="字幕發生錯誤"
      advice="字幕已停止。請重新載入頁面再開始。"
    >
      <MobileApp />
    </ErrorBoundary>
  </StrictMode>,
);
