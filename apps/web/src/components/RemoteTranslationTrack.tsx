import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HealthEvent } from '@meeting-audio/contracts';
import { createCaptureLeaseOwner } from '../providers/capture-lease.js';
import { useOpenAIRealtime } from '../providers/use-openai-realtime.js';
import { useGeminiLive } from '../providers/use-gemini-live.js';
import type { AudioSource, TranslationTrackScope } from '../providers/types.js';
import type { CoalescingHandlersOptions } from '../providers/coalesce-handlers.js';
import { meetingArchive } from '../store/meeting-archive.js';
import { MeetingRecovery, type RecoverySnapshot } from '../providers/meeting-recovery.js';
import { recoveryFailureFor, clearRecoveryRefusal } from '../providers/recovery-attempt.js';

type Backend = 'openai' | 'gemini';
type Archive = NonNullable<CoalescingHandlersOptions['archive']>;
export interface RemoteTranslationHandle {
  prepare(): void;
  start(backend: Backend, archive: Archive, meetingId: string): Promise<boolean>;
  stop(): Promise<void>;
}

/** Owns the remote track; hooks and MeetingRecovery retain connection/retry policy. */
export const RemoteTranslationTrack = forwardRef<RemoteTranslationHandle>(
  function RemoteTranslationTrack(_, ref) {
    const [capture] = useState(() => createCaptureLeaseOwner());
    const [recovery] = useState(() => new MeetingRecovery());
    const connecting = useRef(false);
    const candidate = useRef<Backend | null>(null);
    const sourceBlocked = useRef(false);
    const [healthVersion, updateHealth] = useState(0);
    const epoch = useRef(0);
    const lease = useRef<AudioSource | null>(null);
    const shared = useRef<Promise<boolean> | null>(null);
    const started = useRef<Promise<boolean> | null>(null);
    const admitted = useRef<{ backend: Backend; archive: Archive; meetingId: string } | null>(null);
    const tail = useRef<Promise<void>>(Promise.resolve());
    const [message, setMessage] = useState('尚未分享遠端音訊');
    const [error, setError] = useState<string | null>(null);
    const [backend, setBackend] = useState<Backend | null>(null);
    const meter = useRef<HTMLOutputElement>(null);
    const scope = useMemo<TranslationTrackScope>(
      () => ({
        trackId: 'remote',
        createAudio: () => capture.leaseCapture({ kind: 'system', micDistance: 'off' }),
        onHealth: (event: HealthEvent) => {
          if (event.component === 'audio') {
            if (['failed', 'no_audio_track'].includes(event.state)) sourceBlocked.current = true;
            else if (event.state === 'connected') sourceBlocked.current = false;
          }
          updateHealth((version) => version + 1);
          if (['failed', 'api_error', 'no_audio_track'].includes(event.state))
            setError(event.message ?? '遠端音訊暫時不可用');
          else if (event.state === 'connected') setError(null);
          setMessage(
            event.message ??
              (event.state === 'connected'
                ? '遠端音訊已連接'
                : event.state === 'stopped'
                  ? '遠端收音已停止'
                  : '正在準備遠端字幕'),
          );
        },
        onAudioLevel: (event) => {
          if (meter.current) meter.current.value = `${event.rmsDb.toFixed(0)} dBFS`;
        },
      }),
      [capture],
    );
    const openai = useOpenAIRealtime(scope),
      gemini = useGeminiLive(scope);
    const providers = useRef({ openai, gemini });
    providers.current = { openai, gemini };

    const stop = useCallback(() => {
      epoch.current++;
      recovery.cancel();
      connecting.current = false;
      candidate.current = null;
      capture.releaseCaptureRecovery();
      lease.current?.release();
      lease.current = null;
      shared.current = null;
      started.current = null;
      admitted.current = null;
      setError(null);
      const drain = Promise.all([providers.current.openai.stop(), providers.current.gemini.stop()]);
      tail.current = Promise.all([tail.current, drain]).then(() => {});
      setMessage('遠端收音已停止');
      return tail.current;
    }, [capture, recovery]);
    const prepare = useCallback(() => {
      if (shared.current) return;
      setError(null);
      sourceBlocked.current = false;
      setMessage('請選擇遠端分享來源並勾選音訊');
      const generation = ++epoch.current;
      const source = capture.leaseCapture({ kind: 'system', micDistance: 'off' });
      lease.current = source;
      // Must run within the user's click, before admission or token requests await I/O.
      shared.current = source.acquire(scope.onHealth).then(
        () => generation === epoch.current,
        () => {
          if (generation === epoch.current) setError('未取得遠端音訊；麥克風可繼續，請重新分享。');
          return false;
        },
      );
    }, [capture, scope]);
    const start = useCallback(
      (target: Backend, archive: Archive, meetingId: string): Promise<boolean> => {
        if (started.current) return started.current;
        const generation = epoch.current;
        const permission = shared.current;
        if (!permission) return Promise.resolve(false);
        admitted.current = { backend: target, archive, meetingId };
        recovery.begin(true);
        connecting.current = true;
        setBackend(target);
        capture.retainCaptureForRecovery((event) => {
          scope.onHealth(event);
          meetingArchive.recordRetentionGap(event, meetingId);
        });
        started.current = (async () => {
          if (!(await permission) || generation !== epoch.current) return false;
          await tail.current;
          if (generation !== epoch.current) return false;
          const ok = await providers.current[target].start({ archive });
          if (generation === epoch.current) {
            lease.current?.release();
            lease.current = null;
          }
          return generation === epoch.current && ok;
        })()
          .catch(() => {
            if (generation === epoch.current) setError('遠端翻譯未能開始，請重新分享音訊。');
            return false;
          })
          .finally(() => {
            if (generation === epoch.current) {
              connecting.current = false;
              updateHealth((version) => version + 1);
            }
          });
        return started.current;
      },
      [capture, scope, recovery],
    );
    useEffect(() => {
      const owner = admitted.current;
      if (!owner) return;
      const current = providers.current;
      const pending = candidate.current;
      if (pending && !connecting.current) {
        const incumbentReady = current[owner.backend].getTransport() === 'connected';
        const candidateReady = current[pending].getTransport() === 'connected';
        const candidateFailed =
          current[pending].status !== 'running' ||
          ['failed', 'api_error'].includes(current[pending].getTransport());
        if (incumbentReady || candidateReady || candidateFailed) {
          candidate.current = null;
          if (!incumbentReady && candidateReady) {
            current[owner.backend].stop({ preserveHealth: true });
            owner.backend = pending;
            setBackend(pending);
          } else current[pending].stop({ preserveHealth: true });
          current[owner.backend].restoreHealth();
        }
      }
      const readCurrent = (): RecoverySnapshot => {
        const selected = admitted.current?.backend ?? owner.backend;
        const hooks = providers.current;
        return {
          online: true,
          sessionRunning: admitted.current !== null,
          sourceBlocked: sourceBlocked.current || connecting.current || candidate.current !== null,
          sourceRetryOnly: recoveryFailureFor(selected, 'translation')?.layer === 'audio',
          selectedBackend: selected,
          runningBackend: hooks[selected].status === 'running' ? selected : null,
          anyProviderRunning:
            hooks.openai.status === 'running' || hooks.gemini.status === 'running',
          transportState: hooks[selected].getTransport(),
          available: {
            openai: hooks.openai.apiKeyStatus === 'present',
            gemini: hooks.gemini.available,
          },
          failures: {
            openai: recoveryFailureFor('openai', 'translation'),
            gemini: recoveryFailureFor('gemini', 'translation'),
          },
        };
      };
      recovery.update(readCurrent(), readCurrent, (action) => {
        const generation = epoch.current;
        const admission = admitted.current;
        if (!admission) return;
        connecting.current = true;
        candidate.current = action.target === admission.backend ? null : action.target;
        void providers.current[action.target]
          .start({ archive: admission.archive, awaitContent: true })
          .catch(() => false)
          .finally(() => {
            if (generation === epoch.current) {
              connecting.current = false;
              updateHealth((version) => version + 1);
            }
          });
      });
    }, [
      recovery,
      healthVersion,
      backend,
      openai.status,
      openai.apiKeyStatus,
      gemini.status,
      gemini.available,
    ]);
    useImperativeHandle(ref, () => ({ prepare, start, stop }), [prepare, start, stop]);
    useEffect(
      () => () => {
        void stop();
      },
      [stop],
    );
    const visibleError =
      error ?? (backend === 'openai' ? openai.error : backend === 'gemini' ? gemini.error : null);
    return (
      <section aria-label="遠端翻譯狀態">
        <p>雙軌：麥克風與遠端各一路雲端連線、分別計費；請使用耳機避免重複收音。</p>
        <p role="status">
          {backend === 'openai' ? 'OpenAI' : backend === 'gemini' ? 'Gemini' : '遠端'} · {message} ·{' '}
          <output ref={meter} aria-label="遠端音量">
            —
          </output>
        </p>
        {visibleError && (
          <>
            <p role="alert">{visibleError}</p>
            <button
              onClick={() => {
                const previous = admitted.current;
                if (previous) clearRecoveryRefusal(previous.backend, 'translation');
                void stop();
                prepare();
                if (previous) void start(previous.backend, previous.archive, previous.meetingId);
              }}
            >
              重新分享遠端音訊
            </button>
          </>
        )}
      </section>
    );
  },
);
