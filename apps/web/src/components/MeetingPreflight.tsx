import { useEffect, useRef, useState } from 'react';
import { leaseCapture } from '../providers/capture-lease.js';
import {
  ensureCaptureWorklet,
  getCaptureContext,
  resumeAudioContext,
} from '../providers/audio-engine.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { meetingArchive } from '../store/meeting-archive.js';
import { ONLINE_SERVICE_URL } from '../config.js';

type Probe = {
  audio: string;
  track: string;
  samples: number;
  level: string;
  broker: string;
  archive: string;
};
const empty: Probe = {
  audio: '尚未試音',
  track: '',
  samples: 0,
  level: '',
  broker: '尚未檢查',
  archive: '尚未檢查',
};
const dsp = (v: boolean | undefined) => (v === undefined ? '未回報' : v ? '開' : '關');

/** A temporary consumer of the existing capture lease. Never starts a provider or stores PCM. */
export function MeetingPreflight({
  disabled,
  onActive,
}: {
  disabled: boolean;
  onActive: (active: boolean) => void;
}) {
  const source = useSettingsStore((s) => s.audioSource);
  const distance = useSettingsStore((s) => s.micDistance);
  const mode = useSettingsStore((s) => s.modeId);
  const purpose = useSettingsStore((s) => s.captionTask.purpose);
  const provider = useSettingsStore((s) => s.onlineProvider);
  const [active, setActive] = useState(false);
  const [result, setResult] = useState<Probe>(empty);
  const cancel = useRef<(() => void) | null>(null);
  const unsupported = mode !== 'online_full' && source === 'system';

  useEffect(() => {
    setResult(empty);
    return () => {
      cancel.current?.();
    };
  }, [source, distance, mode, purpose, provider]);

  const start = () => {
    cancel.current?.();
    const abort = new AbortController();
    const capture = leaseCapture({ kind: source, micDistance: distance });
    let node: AudioWorkletNode | null = null;
    let input: MediaStreamAudioSourceNode | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let samples = 0,
      previous = 0,
      lastFrame = performance.now(),
      rms = 0;
    const update = (patch: Partial<Probe>) => {
      if (!abort.signal.aborted) setResult((r) => ({ ...r, ...patch }));
    };
    const stop = () => {
      if (abort.signal.aborted) return;
      abort.abort();
      clearInterval(timer);
      if (node) {
        node.port.onmessage = null;
        node.port.close();
        node.disconnect();
      }
      input?.disconnect();
      capture.release();
      setResult((r) => ({
        ...r,
        broker: r.broker === '檢查中' ? '檢查已取消' : r.broker,
        archive: r.archive === '檢查中' ? '檢查已取消' : r.archive,
      }));
      setActive(false);
      onActive(false);
    };
    cancel.current = stop;
    setResult({ ...empty, audio: '等待收音權限；可隨時取消', broker: '檢查中', archive: '檢查中' });
    setActive(true);
    onActive(true);
    // This must precede any await: display capture requires the click's user activation.
    const acquired = capture.acquire((event) => {
      if (event.state === 'failed' || event.state === 'no_audio_track') {
        update({
          audio:
            event.state === 'no_audio_track'
              ? '未分享音訊。請重新試音並勾選分享音訊。'
              : '收音失敗。請確認權限與裝置後重新試音。',
        });
        stop();
      }
    });
    void (async () => {
      try {
        const stream = await acquired;
        if (abort.signal.aborted) {
          capture.release();
          return;
        }
        const tracks = stream.getAudioTracks();
        const track = tracks[0];
        if (!track) throw new Error('no_audio_track');
        const settings = track.getSettings();
        const ctx = getCaptureContext();
        if (!ctx) throw new Error('AudioContext unavailable');
        update({
          audio: '正在量測 PCM',
          track: `${source === 'mic' ? '麥克風' : '瀏覽器分享音訊'}：${track.label || '裝置名稱未回報'}；${tracks.length} audio track；來源 ${settings.sampleRate ?? '未回報'} Hz；PCM ${ctx.sampleRate} Hz；EC ${dsp(settings.echoCancellation)} / NS ${dsp(settings.noiseSuppression)} / AGC ${dsp(settings.autoGainControl)}`,
        });
        await Promise.all([
          ensureCaptureWorklet(ctx, abort.signal),
          resumeAudioContext(ctx, abort.signal),
        ]);
        if (abort.signal.aborted) return;
        input = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'pcm-worklet', { processorOptions: { chunkSize: 1024 } });
        node.port.onmessage = (event) => {
          if (abort.signal.aborted || !(event.data instanceof ArrayBuffer)) return;
          const pcm = new Float32Array(event.data);
          samples += pcm.length;
          lastFrame = performance.now();
          let sum = 0;
          for (const sample of pcm) sum += sample * sample;
          rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
        };
        input.connect(node);
        node.connect(ctx.destination); // processor produces silence; no microphone monitoring
        lastFrame = performance.now();
        timer = setInterval(() => {
          const advancing = samples > previous;
          update({
            samples,
            audio: advancing
              ? 'PCM 持續前進'
              : performance.now() - lastFrame > 2000
                ? 'PCM 未前進。請確認音源後結束並重新試音。'
                : '等待 PCM',
            level:
              rms > 0.001
                ? `偵測到聲音（${(20 * Math.log10(rms)).toFixed(1)} dBFS）`
                : '目前靜音；請說話或播放會議聲音確認音源。',
          });
          previous = samples;
        }, 250);
      } catch {
        if (!abort.signal.aborted)
          update({ audio: '收音失敗。請確認權限、分享音訊與裝置後重新試音。' });
        stop();
        // A lease can settle after cancellation; return any late ownership too.
        capture.release();
      }
    })();
    void fetch(`${ONLINE_SERVICE_URL}/healthz`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('broker unavailable');
        const health = (await response.json()) as {
          service?: string;
          version?: string;
          components?: { apiKey?: string; gemini_key?: string };
        };
        if (health.service !== 'online') throw new Error('unexpected broker');
        const configured =
          provider === 'gemini' ? health.components?.gemini_key : health.components?.apiKey;
        update({
          broker: `本機服務可連線（版本 ${health.version ?? '未回報'}）；${provider} 金鑰${configured === 'configured' ? '已設定' : '未設定'}。雲端辨識尚未驗證。`,
        });
      })
      .catch(() =>
        update({ broker: '本機服務無法連線。請確認服務啟動後重新試音；雲端辨識尚未驗證。' }),
      );
    void meetingArchive
      .checkAvailability()
      .then(() => update({ archive: '保存服務可用（非完整寫入驗證）' }))
      .catch(() => update({ archive: '保存服務不可用。請確認本機服務與儲存空間後重新試音。' }));
  };

  return (
    <section
      hidden={disabled}
      className="meeting-preflight"
      aria-label="開會前本機檢查"
      style={{ padding: '0.75rem 1rem', borderBottom: '1px solid currentColor' }}
    >
      <strong>開會前本機檢查 · {purpose === 'transcription' ? '純字幕' : '翻譯'}</strong>{' '}
      {active ? (
        <button
          onClick={() => {
            cancel.current?.();
            setResult((r) => ({ ...r, audio: '試音已結束；已釋放收音' }));
          }}
        >
          結束試音
        </button>
      ) : (
        <button disabled={disabled || unsupported} onClick={start}>
          本機試音
        </button>
      )}
      <small> 只在本機量測，不辨識、不錄音。結束試音後再開始會議。</small>
      {unsupported && (
        <p>本機迴路音源（WASAPI）尚未支援此預檢；不能以瀏覽器分享試音代表此路徑已驗證。</p>
      )}
      <div role="status">
        <p>
          {result.audio} {result.samples > 0 && `· ${result.samples} samples`} {result.level}
        </p>
        {result.track && (
          <details>
            <summary>實際裝置與音訊格式</summary>
            <p>{result.track}</p>
          </details>
        )}
        <p>服務：{result.broker}</p>
        {mode === 'online_full' && (
          <p>雲端連線與瀏覽器音訊傳送須在開始會議後確認；公司代理可用不代表音訊傳送已通過。</p>
        )}
        <p>
          保存：{result.archive}
          。翻譯與純字幕均使用地端保存佇列；實際保存與結案結果以會議保存狀態為準。
        </p>
        {mode !== 'online_full' && <p>離線辨識／翻譯模型尚未驗證；試音不載入模型。</p>}
      </div>
    </section>
  );
}
