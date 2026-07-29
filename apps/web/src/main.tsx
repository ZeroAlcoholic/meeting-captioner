import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';
import './providers/field-test-recorder.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
