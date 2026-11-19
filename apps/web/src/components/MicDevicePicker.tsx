import { useEffect, useState } from 'react';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';

/** Enumerates only; permission is requested by the explicit meeting Start. */
export function MicDevicePicker({ disabled = false }: { disabled?: boolean }) {
  const selected = useSettingsStore((s) => s.micDeviceId);
  const audioState = useSettingsStore((s) => s.health.audio.state);
  const system = useSettingsStore((s) => s.audioSource === 'system');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let current = true;
    let generation = 0;
    const media = navigator.mediaDevices;
    const refresh = async () => {
      const admitted = ++generation;
      try {
        const all = await media.enumerateDevices();
        if (!current || admitted !== generation) return;
        setDevices(
          all.filter(
            (d) =>
              d.kind === 'audioinput' &&
              d.deviceId &&
              d.deviceId !== 'default' &&
              d.deviceId !== 'communications',
          ),
        );
        setUnavailable(false);
      } catch {
        if (current && admitted === generation) setUnavailable(true);
      }
    };
    void refresh();
    media?.addEventListener?.('devicechange', refresh);
    return () => {
      current = false;
      media?.removeEventListener?.('devicechange', refresh);
    };
  }, [audioState]);
  const missing = selected && !devices.some((d) => d.deviceId === selected);
  return (
    <label>
      麥克風裝置{' '}
      <select
        data-testid="mic-device-select"
        value={selected}
        disabled={disabled || system}
        onChange={(e) => settingsStore.getState().setMicDeviceId(e.target.value)}
      >
        <option value="">作業系統預設麥克風</option>
        {missing && <option value={selected}>已選裝置（目前無法列出）</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `麥克風 ${i + 1}（開始收音授權後顯示名稱）`}
          </option>
        ))}
      </select>
      {(missing || unavailable) && <small> 裝置不可用時不會改用其他麥克風。</small>}
    </label>
  );
}
