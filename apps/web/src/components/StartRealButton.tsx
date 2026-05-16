import { memo, useEffect, useState } from 'react';
import type { ApiKeyStatus } from '../providers/use-openai-realtime.js';

const TICK_MS = 1_000;

function formatEta(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export interface StartRealButtonProps {
  apiKeyStatus: ApiKeyStatus;
  running: boolean;
  isOtherRunning: boolean;
  onClick: () => void;
  getRenewalEtaMs: () => number | null;
}

const LABEL_BY_STATUS: Record<ApiKeyStatus, string> = {
  checking:       '🎤 Checking…',
  present:        '🎤 Start Real',
  'no-key':       '🔑 No API Key',
  'service-down': '⚠ Online Service Down',
};

const BASE_TITLE_BY_STATUS: Record<ApiKeyStatus, string | undefined> = {
  checking:       'Checking online service…',
  present:        undefined,
  'no-key':       'OPENAI_API_KEY not configured on server',
  'service-down': 'Online service unreachable — start it via start-dev.bat',
};

/**
 * Start Real button — own component so the 1 Hz renewal countdown ticks
 * here without re-rendering App.tsx (and through it the caption-board shell).
 */
export const StartRealButton = memo(function StartRealButton(props: StartRealButtonProps) {
  const { apiKeyStatus, running, isOtherRunning, onClick, getRenewalEtaMs } = props;

  // Local tick state — only this component re-renders each second.
  const [etaMs, setEtaMs] = useState<number | null>(() => (running ? getRenewalEtaMs() : null));

  useEffect(() => {
    if (!running) {
      setEtaMs(null);
      return undefined;
    }
    setEtaMs(getRenewalEtaMs());
    const id = setInterval(() => setEtaMs(getRenewalEtaMs()), TICK_MS);
    return () => clearInterval(id);
  }, [running, getRenewalEtaMs]);

  const disabled = apiKeyStatus !== 'present' || isOtherRunning;
  const renewalSuffix =
    running && etaMs !== null ? ` — Auto-renew in ${formatEta(etaMs)}` : '';
  const baseTitle = BASE_TITLE_BY_STATUS[apiKeyStatus];
  const title =
    apiKeyStatus === 'present'
      ? renewalSuffix
        ? `Online ready${renewalSuffix}`
        : undefined
      : baseTitle;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid="start-real"
    >
      {LABEL_BY_STATUS[apiKeyStatus]}
    </button>
  );
});
