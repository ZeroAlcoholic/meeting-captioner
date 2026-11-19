import { useState, useSyncExternalStore } from 'react';
import { meetingArchive } from '../store/meeting-archive.js';
import { triggerDownload } from '../export/download.js';
import { captionStore, useCaptionStore } from '../store/use-caption-store.js';

/** Shared by both meeting purposes; backup work never owns the caption lifecycle. */
export function BackupControls() {
  const [backupId, setBackupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [database, setDatabase] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [preservePending, setPreservePending] = useState(false);
  const phase = useCaptionStore((state) => state.sessionPhase);
  const active = phase === 'running' || phase === 'paused';
  const archive = useSyncExternalStore(meetingArchive.subscribe, meetingArchive.getStatus);
  const awaitingFinalization =
    archive.meetingId !== null && (archive.finalizing || !archive.manifest?.saved);
  const run = async (
    action: () => Promise<void>,
    failureMessage = '備份或下載失敗，請確認本機服務已更新且保存狀態正常後重試。原會議資料仍保留。',
  ) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch {
      setError(failureMessage);
    } finally {
      setBusy(false);
    }
  };
  const download = (file: 'meetings.sqlite' | 'manifest.json') =>
    run(async () => {
      if (!backupId) return;
      const blob = await meetingArchive.downloadBackupFile(backupId, file);
      const name = file === 'meetings.sqlite' ? `${backupId}.sqlite` : `${backupId}.manifest.json`;
      triggerDownload(blob, name, blob.type);
      setNotice('已送出下載，請確認資料庫與驗證清單兩個檔案都已保存。');
    });
  return (
    <details
      className="meeting-backup"
      onToggle={(event) => {
        if (event.currentTarget.open) void meetingArchive.checkPendingRestore().catch(() => {});
      }}
    >
      <summary>資料備份</summary>
      <p>
        備份包含所有已保存會議的原稿、譯文、校訂與缺口，不含錄音。會議進行中仍可建立備份；新內容會繼續保存。
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await meetingArchive.backup();
            setBackupId(result.backupId);
            setConfirmed(false);
            setNotice('本機備份已建立。請下載以下兩個檔案，存放在同一資料夾。');
          })
        }
      >
        建立完整備份
      </button>
      {backupId && (
        <div>
          <button disabled={busy} onClick={() => void download('meetings.sqlite')}>
            下載備份資料庫
          </button>
          <button disabled={busy} onClick={() => void download('manifest.json')}>
            下載驗證清單
          </button>
        </div>
      )}
      <fieldset disabled={busy || active || restored || archive.restorePending}>
        <legend>從備份還原</legend>
        <p>
          請先停止會議。選取同一份備份的兩個檔案；匯入只驗證檔案，按下還原才會取代目前資料庫。上限
          512 MiB。
        </p>
        {awaitingFinalization && (
          <p role="status">
            本次會議尚未完成保存與結案，完成後才能還原；請先停止會議，必要時重試保存。
          </p>
        )}
        <label>
          備份資料庫
          <input
            type="file"
            accept=".sqlite"
            onChange={(event) => {
              setDatabase(event.target.files?.[0] ?? null);
              setBackupId(null);
              setNotice('');
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          驗證清單
          <input
            type="file"
            accept=".json"
            onChange={(event) => {
              setManifest(event.target.files?.[0] ?? null);
              setBackupId(null);
              setNotice('');
              setConfirmed(false);
            }}
          />
        </label>
        <button
          disabled={!database || !manifest}
          onClick={() =>
            void run(async () => {
              if (!database || !manifest) return;
              setBackupId(await meetingArchive.importBackup(database, manifest));
              setConfirmed(false);
              setNotice('備份驗證通過，尚未還原。請確認後執行還原。');
            }, '操作未完成：匯入驗證失敗，請確認選取同一份備份的兩個完整檔案。本機會議資料未因匯入而變更。')
          }
        >
          匯入並驗證備份
        </button>
        {backupId && (
          <>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我確認以此備份取代目前資料；系統會先保留目前資料的安全副本。
            </label>
            <button
              disabled={!confirmed || awaitingFinalization}
              onClick={() =>
                void run(async () => {
                  const current = captionStore.getState().sessionPhase;
                  if (current === 'running' || current === 'paused')
                    throw new Error('MEETING_ACTIVE');
                  const latest = meetingArchive.getStatus();
                  if (latest.meetingId && (latest.finalizing || !latest.manifest?.saved))
                    throw new Error('MEETING_NOT_FINALIZED');
                  const result = await meetingArchive.restoreBackup(backupId);
                  setRestored(true);
                  setNotice(
                    `還原完成。原資料安全副本：${result.safetyBackupPath}。請重新載入頁面後使用。`,
                  );
                }, '還原未完成或結果待核對。請保留此分頁，勿清除瀏覽器資料；待存或晚到資料會保留，請確認保存狀態與本機服務。')
              }
            >
              確認還原備份
            </button>
          </>
        )}
      </fieldset>
      {archive.restorePending && (
        <>
          <label>
            <input
              type="checkbox"
              checked={preservePending}
              disabled={busy || active}
              onChange={(event) => setPreservePending(event.target.checked)}
            />
            若還原已套用，將晚到內容另存於此瀏覽器的舊世代保留區後完成還原；不合併到新資料庫。
          </label>
          <button
            disabled={busy || active}
            onClick={() =>
              void run(async () => {
                const result = await meetingArchive.reconcileRestore(preservePending);
                setRestored(true);
                setNotice(
                  `還原完成。原資料安全副本位置：${result.safetyBackupPath}。請重新載入頁面後使用。`,
                );
              }, '還原結果尚未能確認。若剛重新載入，請等 15 秒再核對；其他分頁仍在使用時須先停止。請保留待存資料，勿清除瀏覽器資料。')
            }
          >
            核對並完成上次還原
          </button>
          <button
            disabled={busy || active}
            onClick={() =>
              void run(async () => {
                await meetingArchive.cancelPendingRestore();
                setConfirmed(false);
                setBackupId(null);
                setNotice('已取消本次還原；目前資料與待存內容保留。');
              }, '無法取消：還原可能已套用，或原寫入權限尚未到期。請保留資料並核對上次還原結果。')
            }
          >
            取消待核對的還原
          </button>
        </>
      )}
      {restored && (
        <button
          disabled={archive.pendingCount > 0 || archive.memoryBytes > 0}
          onClick={() => location.reload()}
        >
          重新載入還原後資料
        </button>
      )}
      <button
        disabled={busy || restored}
        onClick={() =>
          void run(async () => {
            const blob = await meetingArchive.exportRetiredRestoreData();
            if (!blob.size) {
              setNotice('此瀏覽器沒有舊世代保留紀錄。');
              return;
            }
            triggerDownload(blob, 'meeting-retired-records.jsonl', blob.type);
            setNotice('已送出舊世代紀錄下載；請確認檔案已保存。瀏覽器內的保留紀錄不會刪除。');
          }, '舊世代紀錄下載失敗，請重新載入後再試；勿清除瀏覽器資料。')
        }
      >
        下載舊世代保留紀錄
      </button>
      <p>
        舊世代紀錄包含另存的晚到內容與缺口，可用文字編輯器讀取
        JSONL；不會自動匯回會議。完成還原後請先重新載入，再下載此檔留存。
      </p>
      {busy && <p role="status">正在處理資料，請保留此分頁。</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <p>
        下載位置依瀏覽器設定；請將兩個檔案另外保存在外接磁碟等位置。同磁碟副本無法防止磁碟故障，系統不會自動刪除舊備份。
      </p>
    </details>
  );
}
