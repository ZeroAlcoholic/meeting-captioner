import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ArchivedSegment, MeetingMetadata } from '@meeting-audio/contracts';
import { ONLINE_SERVICE_URL } from '../config.js';
import { captionStore, useCaptionStore } from '../store/use-caption-store.js';
import { restoreCaptionSession } from '../store/caption-store.js';
import { settingsStore, useSettingsStore } from '../settings/use-settings-store.js';
import { meetingArchive } from '../store/meeting-archive.js';
import type { ArchivePage } from '../store/meeting-archive-client.js';
import { TranscriptionSession } from '../providers/transcription-session.js';
import { OpenAITranscriptionProvider } from '../providers/openai-transcription-provider.js';
import { GeminiTranscriptionProvider } from '../providers/gemini-transcription-provider.js';
import { applyCaptureHealth, createStoreBoundHandlers } from '../providers/coalesce-handlers.js';
import { startSessionInfoPolling } from '../providers/session-info-polling.js';
import {
  leaseCapture,
  retainCaptureForRecovery,
  releaseCaptureRecovery,
  createCaptureLeaseOwner,
} from '../providers/capture-lease.js';
import type { AudioSource, CaptionProviderHandlers } from '../providers/types.js';
import { PureLiveCaptions } from './PureCaptionText.js';
import { MicDevicePicker } from './MicDevicePicker.js';
import { MicLevelBar } from './MicLevelBar.js';
import { PostMeetingBar } from './PostMeetingBar.js';
import './PureCaptionWorkspace.css';

function RecentText() {
  const segments = useCaptionStore((s) => s.segments),
    task = useCaptionStore((s) => s.captionTask);
  return (
    <section className="pure-recent" aria-label="最近字幕">
      <h2>最近字幕</h2>
      <p className="pure-muted">畫面顯示最近 200 段；完整逐字稿請從下方會議紀錄開啟。</p>
      {task?.purpose === 'transcription' &&
        segments.slice(-200).map((s) => (
          <p key={s.segmentId} data-testid="pure-history-line">
            {s.text}
          </p>
        ))}
    </section>
  );
}
function TranscriptEditor({
  segment,
  meetingId,
  onSaved,
}: {
  segment: ArchivedSegment;
  meetingId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(segment.text),
    [error, setError] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  return (
    <article className="pure-archive-segment">
      <small>
        {new Date(segment.startMs).toLocaleTimeString('zh-TW')} ·{' '}
        {segment.status === 'final' ? '已確認' : '未完成辨識'} · 修訂 {segment.revision}
      </small>
      {editing ? (
        <>
          <textarea
            aria-label="校訂文字"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={saving}
          />
          <button
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void meetingArchive
                .correctTranscript(meetingId, segment.segmentId, text, segment.revision)
                .then(() => {
                  setEditing(false);
                  onSaved();
                })
                .catch(() => setError('校訂未保存。請重新讀取，確認其他修訂或保存狀態。'))
                .finally(() => setSaving(false));
            }}
          >
            保存校訂
          </button>
          <button disabled={saving} onClick={() => setEditing(false)}>
            取消
          </button>
        </>
      ) : (
        <>
          <p>{segment.text}</p>
          <button
            onClick={() => {
              setText(segment.text);
              setEditing(true);
            }}
          >
            校訂
          </button>
        </>
      )}
      <details>
        <summary>原始辨識</summary>
        <p>{segment.rawText ?? segment.originalText}</p>
      </details>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function PureCaptionWorkspace() {
  const selectedDual = useSettingsStore((s) => s.scenarioId === 'hybrid');
  const activeDual = useCaptionStore((s) => s.separateTracks && s.sessionPhase === 'running');
  const separateTracks = selectedDual || activeDual;
  const [remoteCapture] = useState(() => createCaptureLeaseOwner());
  const remoteController = useRef<TranscriptionSession | null>(null);
  const remoteLease = useRef<AudioSource | null>(null);
  const remoteHandlers = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [remoteView, setRemoteView] = useState({
    phase: 'idle',
    error: null,
    backend: null,
  } as ReturnType<TranscriptionSession['getSnapshot']>);
  const [remoteAudio, setRemoteAudio] = useState('尚未分享音訊');
  // Meter updates must not rerender the workspace, archive editor, or caption history.
  const remoteLevel = useRef<HTMLOutputElement>(null);
  const task = useSettingsStore((s) => s.captionTask);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const micDistance = useSettingsStore((s) => s.micDistance);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);
  const persist = useSyncExternalStore(
    meetingArchive.subscribe,
    meetingArchive.getStatus,
    meetingArchive.getStatus,
  );
  const [title, setTitle] = useState(''),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [meetings, setMeetings] = useState<MeetingMetadata[]>([]),
    [page, setPage] = useState<ArchivePage | null>(null),
    [offset, setOffset] = useState(0);
  const controller = useRef<TranscriptionSession | null>(null),
    [view, setView] = useState({ phase: 'idle', error: null, backend: null } as ReturnType<
      TranscriptionSession['getSnapshot']
    >);
  const operation = useRef(0),
    mounted = useRef(false),
    outage = useRef<number | null>(null),
    meetingStart = useRef(0);
  const closeGap = useCallback(() => {
    const meeting = meetingArchive.getCurrentMeeting();
    if (outage.current === null || !meeting) return;
    const start = outage.current;
    outage.current = null;
    meetingArchive.recordGap({
      gapId: crypto.randomUUID(),
      meetingId: meeting.meetingId,
      trackId: captionStore.getState().separateTracks
        ? 'mic'
        : settingsStore.getState().audioSource,
      captureEpoch: meeting.createdAt,
      startSample: Math.max(0, Math.floor((start - meetingStart.current) * 16)),
      endSample: Math.max(0, Math.floor((Date.now() - meetingStart.current) * 16)),
      sampleRate: 16000,
      state: 'unrecoverable',
      cause: '連線或收音中斷；此期間字幕完整性未確認',
      alignment: 'estimated',
    });
  }, []);
  const refresh = useCallback(async () => {
    setMeetings(await meetingArchive.listMeetings());
  }, []);
  useEffect(() => {
    mounted.current = true;
    const handlers = createStoreBoundHandlers();
    let available = { openai: false, gemini: false };
    const normalized = {
      ...handlers,
      onTranscript: (e: Parameters<typeof handlers.onTranscript>[0]) => {
        meetingArchive.recordTranscript(e);
        handlers.onTranscript(e);
      },
      onHealth: (e: Parameters<typeof handlers.onHealth>[0]) => {
        handlers.onHealth(e);
        const meeting = meetingArchive.getCurrentMeeting();
        if (e.captureGap && meeting)
          meetingArchive.recordGap({
            gapId: crypto.randomUUID(),
            meetingId: meeting.meetingId,
            trackId: captionStore.getState().separateTracks
              ? 'mic'
              : settingsStore.getState().audioSource,
            ...e.captureGap,
            state: 'unrecoverable',
            alignment: 'estimated',
            cause: '疑似休眠或排程中斷；此期間收音完整性未確認',
          });
        if (
          !e.captureGap &&
          ['failed', 'api_error', 'no_audio_track', 'reconnecting', 'degraded'].includes(e.state)
        ) {
          outage.current ??= Date.now();
        }
        const health = settingsStore.getState().health;
        if (
          health.transport.state === 'connected' &&
          health.audio.state === 'connected' &&
          health.audio.reason === 'capture_resumed'
        )
          closeGap();
      },
    };
    const makeProvider = (
      h: CaptionProviderHandlers,
      backend: 'openai' | 'gemini',
      remote = false,
    ) => {
      const settings = settingsStore.getState(),
        system =
          remote || (!captionStore.getState().separateTracks && settings.audioSource === 'system');
      const actualTask = settings.captionTask;
      if (actualTask.purpose !== 'transcription') throw new Error('此工作區僅支援純字幕');
      const Provider =
        backend === 'gemini' ? GeminiTranscriptionProvider : OpenAITranscriptionProvider;
      return new Provider({
        sessionUrl: `${ONLINE_SERVICE_URL}/session/${backend === 'gemini' ? 'gemini/' : ''}transcription`,
        handlers: h,
        task: actualTask,
        audioSource: (remote ? remoteCapture.leaseCapture : leaseCapture)({
          kind: system ? 'system' : 'mic',
          micDistance: system ? 'off' : settings.micDistance,
          deviceId: settings.micDeviceId,
        }),
        micDistance: system ? 'off' : settings.micDistance,
        source: system ? 'browser_system' : 'microphone',
      });
    };
    const session = new TranscriptionSession(
      (h, backend) => makeProvider(h, backend),
      normalized,
      () => settingsStore.getState().onlineProvider,
      () => available,
    );
    const remoteSession = new TranscriptionSession(
      (h, backend) => makeProvider(h, backend, true),
      {
        onTranscript: (e) => remoteHandlers.current?.onTranscript(e),
        onTranslation: (e) => remoteHandlers.current?.onTranslation(e),
        onHealth: (e) => remoteHandlers.current?.onHealth(e),
        onAudioLevel: (e) => remoteHandlers.current?.onAudioLevel(e),
      },
      () => settingsStore.getState().onlineProvider,
      () => available,
    );
    remoteController.current = remoteSession;
    const unsubscribeRemote = remoteSession.subscribe(() => {
      if (mounted.current) setRemoteView(remoteSession.getSnapshot());
    });
    const stopPolling = startSessionInfoPolling(
      `${ONLINE_SERVICE_URL}/session/info`,
      (info) => {
        const configured = (provider: 'openai' | 'gemini') =>
          Array.isArray(info.taskCapabilities)
            ? info.taskCapabilities.some(
                (capability) =>
                  capability?.provider === provider &&
                  capability.purpose === 'transcription' &&
                  capability.configured === true,
              )
            : provider === 'openai'
              ? info.hasApiKey === true
              : (info.hasGeminiKey ?? info.availableProviders?.includes('gemini')) === true;
        available = { openai: configured('openai'), gemini: configured('gemini') };
        session.refreshAvailability();
        remoteSession.refreshAvailability();
      },
      () => {
        available = { openai: false, gemini: false };
        session.refreshAvailability();
        remoteSession.refreshAvailability();
      },
    );
    controller.current = session;
    const unsubscribe = session.subscribe(() => {
      if (mounted.current) setView(session.getSnapshot());
    });
    void meetingArchive
      .initialize()
      .then(refresh)
      .catch(() => {
        if (mounted.current) setError('地端保存尚未就緒；請查看保存狀態並重試。');
      });
    const checkpoint = () => meetingArchive.checkpoint();
    window.addEventListener('pagehide', checkpoint);
    return () => {
      mounted.current = false;
      ++operation.current;
      unsubscribe();
      unsubscribeRemote();
      stopPolling();
      releaseCaptureRecovery();
      session.dispose();
      remoteCapture.releaseCaptureRecovery();
      remoteLease.current?.release();
      remoteLease.current = null;
      remoteSession.dispose();
      remoteHandlers.current?.finish();
      handlers.flushPending();
      meetingArchive.checkpoint();
      window.removeEventListener('pagehide', checkpoint);
    };
  }, [closeGap, refresh, remoteCapture]);
  const running =
    ['starting', 'running', 'recovering', 'stopping', 'failed'].includes(view.phase) || busy;
  const start = async (existing?: MeetingMetadata) => {
    if (running || task.purpose !== 'transcription') return;
    const owner = ++operation.current;
    // Invoke the share picker directly from the click, before archive I/O loses user activation.
    const dual = existing
      ? existing.separateTracks === true
      : settingsStore.getState().scenarioId === 'hybrid';
    remoteHandlers.current?.finish();
    remoteHandlers.current = null;
    setRemoteAudio(dual ? '請選擇分享來源並勾選音訊' : '尚未分享音訊');
    if (remoteLevel.current) remoteLevel.current.value = '—';
    const share = dual
      ? remoteCapture.leaseCapture({
          kind: 'system',
          micDistance: 'off',
          deviceId: settingsStore.getState().micDeviceId,
        })
      : null;
    remoteLease.current = share;
    const shared = share
      ?.acquire(() => {})
      .then(
        () => true,
        () => false,
      );
    setBusy(true);
    setError(null);
    setPage(null);
    settingsStore.setState({ sessionStartAt: Date.now(), activeSessionBilingual: false });
    try {
      if (existing) {
        const meeting = await meetingArchive.continueMeeting(existing.meetingId);
        const first = await meetingArchive.loadMeeting(meeting.meetingId);
        const tail =
          first.totalSegments > 200
            ? await meetingArchive.loadMeeting(meeting.meetingId, first.totalSegments - 200)
            : first;
        meetingStart.current = Date.parse(meeting.createdAt);
        restoreCaptionSession(captionStore, {
          meetingId: meeting.meetingId,
          captionTask: meeting.captionTask,
          segments: tail.segments,
          sessionMode: 'real',
          sessionStartMs: meetingStart.current,
          separateTracks: dual,
        });
        if (!first.manifest) {
          const last = tail.segments.at(-1);
          const from = last?.endMs ?? last?.startMs ?? meetingStart.current;
          meetingArchive.recordGap({
            gapId: crypto.randomUUID(),
            meetingId: meeting.meetingId,
            trackId: settingsStore.getState().audioSource,
            captureEpoch: meeting.createdAt,
            startSample: Math.max(0, Math.floor((from - meetingStart.current) * 16)),
            endSample: Math.max(0, Math.floor((Date.now() - meetingStart.current) * 16)),
            sampleRate: 16000,
            state: 'unrecoverable',
            cause: '重新開啟未結案會議；中斷期間沒有留存錄音可核對',
            alignment: 'estimated',
          });
        }
      } else {
        captionStore.getState().beginSession('real', task, dual);
        const now = new Date();
        meetingStart.current = now.getTime();
        await meetingArchive.startMeeting({
          meetingId: captionStore.getState().sessionId!,
          title: title.trim() || `會議 ${now.toLocaleString('zh-TW')}`,
          createdAt: now.toISOString(),
          captionTask: task,
          ...(dual ? { separateTracks: true } : {}),
        });
      }
      if (owner !== operation.current || !mounted.current) return;
      captionStore.setState({ separateTracks: dual });
      if (dual) {
        remoteHandlers.current = createStoreBoundHandlers({
          archive: meetingArchive.bindCurrentMeeting(),
          trackId: 'remote',
          onHealth: (e) => {
            if (e.component === 'audio')
              setRemoteAudio(
                e.message ?? (e.state === 'connected' ? '音訊已連接' : '正在確認音訊狀態'),
              );
          },
          onAudioLevel: (e) => {
            if (remoteLevel.current) remoteLevel.current.value = `${e.rmsDb.toFixed(0)} dBFS`;
          },
        });
        remoteCapture.retainCaptureForRecovery((e) => {
          remoteHandlers.current?.onHealth(e);
          meetingArchive.recordRetentionGap(e, captionStore.getState().sessionId);
        });
      }
      captionStore.getState().setSessionPhase('running');
      retainCaptureForRecovery(
        (e) => applyCaptureHealth(e, meetingArchive),
        () => {
          void controller.current?.start(false);
        },
      );
      const localStart = controller.current?.start();
      if (dual) {
        const ready = await shared;
        if (owner !== operation.current || !mounted.current) return;
        if (ready) {
          await remoteController.current?.start();
        } else {
          setRemoteView({
            phase: 'failed',
            backend: null,
            error: '遠端音訊未取得；麥克風可繼續，請重新分享音訊。',
          });
          setRemoteAudio('尚未取得遠端音訊');
        }
        share?.release();
        if (remoteLease.current === share) remoteLease.current = null;
      }
      await localStart;
    } catch {
      if (owner === operation.current) {
        remoteCapture.releaseCaptureRecovery();
        share?.release();
        remoteLease.current = null;
        setError('無法開始。請確認此分頁具有寫入權限與收音權限。');
        settingsStore.setState({ sessionStartAt: null, activeSessionBilingual: null });
        captionStore.getState().endSession();
      }
    } finally {
      if (owner === operation.current) setBusy(false);
    }
  };
  const stop = async () => {
    ++operation.current;
    setBusy(true);
    setError(null);
    releaseCaptureRecovery();
    remoteCapture.releaseCaptureRecovery();
    remoteLease.current?.release();
    remoteLease.current = null;
    try {
      const finishedId = meetingArchive.getCurrentMeeting()?.meetingId;
      await Promise.all([controller.current?.stop(), remoteController.current?.stop()]);
      remoteHandlers.current?.finish();
      closeGap();
      captionStore.getState().endSession();
      settingsStore.setState({ sessionStartAt: null, activeSessionBilingual: null });
      await meetingArchive.finalize();
      await meetingArchive.release();
      await refresh();
      if (finishedId && mounted.current) {
        try {
          setPage(await meetingArchive.loadMeeting(finishedId, 0));
          setOffset(0);
        } catch {
          /* ignore auto-load error so stop() never shows a false save failure */
        }
      }
    } catch {
      setError('收音已停止，但逐字稿尚未完成保存或結案。請保留此分頁並重試保存。');
    } finally {
      setBusy(false);
    }
  };
  const load = async (id: string, next = 0) => {
    try {
      setPage(await meetingArchive.loadMeeting(id, next));
      setOffset(next);
      setError(null);
    } catch {
      setError('會議紀錄讀取失敗，請重試。');
    }
  };
  const retryFinalize = async () => {
    try {
      if (page && meetingArchive.getCurrentMeeting()?.meetingId !== page.meeting.meetingId)
        await meetingArchive.continueMeeting(page.meeting.meetingId);
      await meetingArchive.finalize();
      await meetingArchive.release();
      await refresh();
    } catch {
      setError('仍有未保存資料，請檢查地端服務或寫入權限。');
    }
  };
  const download = async (variant: 'original' | 'corrected', format: 'txt' | 'json' | 'srt') => {
    const id = page?.meeting.meetingId ?? persist.meetingId;
    if (!id) return;
    try {
      if (persist.pendingCount > 0) await meetingArchive.flushPending();
      const blob = await meetingArchive.exportMeeting(id, variant, format),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `${id}-${variant}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('匯出失敗或仍有未保存資料，請先重試保存。');
    }
  };
  const phaseLabels = {
    idle: '尚未開始',
    starting: '連線與收音準備中',
    running: '正在顯示純字幕',
    recovering: '連線中斷，正嘗試恢復純字幕服務',
    failed: '需要人工處理',
    stopping: '停止收音，等待最後片段',
    stopped: '收音已停止',
  };
  const phaseLabel = phaseLabels[view.phase];
  return (
    <main className="pure-workspace">
      <header>
        <h1>純字幕與會議逐字稿</h1>
        <p>中文以台灣繁體顯示，英文與原文術語保留。逐字稿自動保存在這台電腦。</p>
      </header>
      <section className="pure-controls" aria-label="純字幕設定">
        {separateTracks && (
          <p>
            雙軌：麥克風與遠端各建立一路雲端轉寫，兩路分別計費。請使用耳機避免遠端聲音再次進入麥克風。
          </p>
        )}
        <label>
          會議名稱{' '}
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={running} />
        </label>
        <label>
          雲端轉寫{' '}
          <select
            value={onlineProvider}
            disabled={running}
            onChange={(e) =>
              settingsStore.getState().setOnlineProvider(e.target.value as 'openai' | 'gemini')
            }
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label>
          音源{' '}
          <select
            value={separateTracks ? 'mic' : audioSource}
            disabled={running || separateTracks}
            onChange={(e) =>
              settingsStore.getState().setAudioSource(e.target.value as 'mic' | 'system')
            }
          >
            <option value="mic">麥克風</option>
            <option value="system">分頁／系統音訊</option>
          </select>
        </label>
        <label>
          收音環境{' '}
          <select
            value={micDistance}
            disabled={running || audioSource === 'system'}
            onChange={(e) =>
              settingsStore.getState().setMicDistance(e.target.value as typeof micDistance)
            }
          >
            <option value="meeting">同室多人會議</option>
            <option value="close">耳麥／近距離</option>
            <option value="far">遠距收音</option>
            <option value="off">不做降噪</option>
          </select>
        </label>
        <MicDevicePicker disabled={running || audioSource === 'system'} />
        <button onClick={() => void start()} disabled={running || persist.state === 'read_only'}>
          開始純字幕
        </button>
        <button onClick={() => void stop()} disabled={!running && view.phase !== 'failed'}>
          停止並保存
        </button>
        {view.phase === 'failed' && (
          <button
            onClick={() => {
              retainCaptureForRecovery(
                (e) => applyCaptureHealth(e, meetingArchive),
                () => {
                  void controller.current?.start(false);
                },
              );
              void controller.current?.start();
            }}
          >
            {settingsStore.getState().health.transport.recoveryFailure
              ? '重新嘗試服務'
              : audioSource === 'system'
                ? '重新分享音訊'
                : '重新取得音源'}
          </button>
        )}
        <button onClick={() => void document.documentElement.requestFullscreen()}>全螢幕</button>
        <MicLevelBar visible={running} />
      </section>
      <p role="status" data-testid="pure-session-status">
        {phaseLabel} · {(view.backend ?? onlineProvider) === 'gemini' ? 'Gemini' : 'OpenAI'}{' '}
        線上純轉寫；離線純字幕尚未驗收
      </p>
      <p className="pure-muted">
        費用依所選雲端服務計算；此畫面尚未取得實際用量。原始辨識與人工校訂分別留存。
      </p>
      {separateTracks && (
        <section aria-label="遠端收音狀態">
          <p role="status">
            遠端：{phaseLabels[remoteView.phase]} · {remoteView.backend ?? onlineProvider} ·{' '}
            {remoteAudio}
            {' · 音量 '}
            <output ref={remoteLevel} aria-label="遠端音量">
              —
            </output>
          </p>
          {remoteView.error && <p role="alert">{remoteView.error}</p>}
          {running && remoteView.phase === 'failed' && (
            <button
              onClick={() => {
                remoteCapture.retainCaptureForRecovery((e) => {
                  remoteHandlers.current?.onHealth(e);
                  meetingArchive.recordRetentionGap(e, captionStore.getState().sessionId);
                });
                void remoteController.current?.start();
              }}
            >
              重新分享遠端音訊
            </button>
          )}
        </section>
      )}
      {(error || view.error) && <p role="alert">{error ?? view.error}</p>}
      <section
        className="pure-persistence"
        aria-label="逐字稿保存狀態"
        data-testid="persistence-status"
      >
        {persist.state === 'read_only' && persist.error !== 'archive_generation_changed' && (
          <button
            onClick={() =>
              void meetingArchive
                .retryWriterOwnership()
                .catch(() => setError('另一個分頁仍持有寫入權限。關閉該分頁後，請等 15 秒再重試。'))
            }
          >
            重新檢查寫入權限
          </button>
        )}
        <strong>
          {persist.state === 'read_only'
            ? persist.error === 'archive_generation_changed'
              ? '本機資料已還原，舊內容暫停寫入'
              : '此分頁唯讀：另一個分頁正在寫入'
            : persist.error
              ? '保存異常，資料尚未全部確認'
              : persist.pendingCount
                ? '正在保存'
                : persist.manifest?.saved
                  ? persist.manifest.gaps.length || persist.manifest.unfinishedTurns.length
                    ? '已保存，逐字稿尚待核對'
                    : '已結案保存'
                  : persist.lastSavedAt
                    ? '已自動保存，尚未結案'
                    : '等待逐字稿'}
        </strong>
        {persist.error === 'archive_generation_changed' && (
          <p role="alert">舊待存內容仍保留。請保留此分頁，勿清除瀏覽器資料；待核對後再恢復保存。</p>
        )}
        {persist.error === 'service_identity_changed' && (
          <p role="alert">
            本機服務的工作區或版本已改變，已停止自動補存。請保留此分頁，恢復原工作區與版本後重試保存；勿清除瀏覽器資料。
          </p>
        )}
        {persist.retryBlocked && persist.error !== 'archive_generation_changed' && (
          <p role="alert">
            本機服務拒絕保存資料，已暫停自動重送；待存逐字稿仍保留。請更新或修復本機服務後，停止收音並按「重試保存／結案」。
          </p>
        )}
        <span>
          待保存 {persist.pendingCount} 筆
          {persist.lastSavedAt
            ? ` · 最近確認 ${new Date(persist.lastSavedAt).toLocaleTimeString('zh-TW')}`
            : ''}
        </span>
        {persist.lostCount > 0 && (
          <p role="alert">有 {persist.lostCount} 筆未能保留，逐字稿不完整。</p>
        )}
        {persist.memoryBytes > 0 ? (
          <p role="alert">尚有內容僅在記憶體中，關閉或重新整理分頁可能遺失。請先恢復本機保存。</p>
        ) : persist.pendingCount > 0 ? (
          <p>內容已暫存於此瀏覽器，尚待本機服務確認保存。</p>
        ) : null}
        {persist.exportFailure && <p role="alert">匯出副本更新失敗，請重試保存後再匯出。</p>}
        {persist.manifest &&
          (!persist.manifest.saved ||
            persist.manifest.gaps.length > 0 ||
            persist.manifest.unfinishedTurns.length > 0) && (
            <p>
              已知缺口 {persist.manifest.gaps.length}；未完成片段{' '}
              {persist.manifest.unfinishedTurns.length}。保留原稿，不能視為完整結案。
            </p>
          )}
        <button
          disabled={running}
          onClick={() => {
            void retryFinalize();
          }}
        >
          重試保存／結案
        </button>
        {persist.dataDirectory && (
          <details>
            <summary>本機保存位置</summary>
            <p>{persist.dataDirectory}</p>
          </details>
        )}
      </section>
      <PureLiveCaptions />
      <RecentText />
      <section className="pure-archive" aria-label="完整會議逐字稿">
        <h2>完整會議紀錄</h2>
        <button onClick={() => void refresh().catch(() => setError('無法讀取會議清單'))}>
          重新整理紀錄
        </button>
        <ul>
          {meetings.map((m) => (
            <li key={m.meetingId}>
              <button disabled={running} onClick={() => void load(m.meetingId)}>
                {m.title || m.createdAt}
              </button>
              {m.captionTask.purpose === 'transcription' && (
                <button disabled={running} onClick={() => void start(m)}>
                  繼續此會議
                  {m.separateTracks && '（雙軌，兩路分別計費）'}
                </button>
              )}
            </li>
          ))}
        </ul>
        {page && (
          <>
            <h3>{page.meeting.title}</h3>
            <p>
              共 {page.totalSegments} 段 · 本頁 {offset + 1}–{offset + page.segments.length} ·
              時碼為音訊擷取估計值
            </p>
            <div className="pure-controls">
              {(['txt', 'srt', 'json'] as const).map((f) => (
                <button key={f} onClick={() => void download('corrected', f)}>
                  匯出校訂版 {f.toUpperCase()}
                </button>
              ))}
              <button onClick={() => void download('original', 'txt')}>匯出原稿 TXT</button>
              <button onClick={() => void download('original', 'json')}>
                匯出完整原始紀錄 JSON
              </button>
            </div>
            {!running && page.segments.length > 0 && (
              <PostMeetingBar
                pureArchiveMeeting={{
                  meetingId: page.meeting.meetingId,
                  title: page.meeting.title,
                  createdAt: page.meeting.createdAt,
                  segments: page.segments,
                  ...(page.manifest?.gaps.length
                    ? { gaps: page.manifest.gaps.map((g) => g.cause || '收音或連線中斷缺口') }
                    : {}),
                }}
              />
            )}
            {page.segments.map((s) => (
              <TranscriptEditor
                key={`${s.segmentId}:${s.revision}`}
                segment={s}
                meetingId={page.meeting.meetingId}
                onSaved={() => void load(page.meeting.meetingId, offset)}
              />
            ))}
            <button
              disabled={offset === 0}
              onClick={() => void load(page.meeting.meetingId, Math.max(0, offset - 200))}
            >
              上一頁
            </button>
            <button
              disabled={offset + page.segments.length >= page.totalSegments}
              onClick={() => void load(page.meeting.meetingId, offset + 200)}
            >
              下一頁
            </button>
          </>
        )}
      </section>
    </main>
  );
}
