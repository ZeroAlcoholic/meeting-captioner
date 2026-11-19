import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMeetings } from './meetings.js';
import type { MeetingRepository } from '../storage/meeting-repository.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const writerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const meetingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function repo() {
  return {
    listMeetings: vi.fn(async () => []),
    createMeeting: vi.fn(async (x) => x),
    commitEvents: vi.fn(),
    close: vi.fn(async () => {}),
    refreshExports: vi.fn(async () => {}),
    readRevisions: vi.fn(async () => ({ revisions: [], nextOffset: null })),
    readPage: vi.fn(async () => ({ segments: [] })),
    backupFile: vi.fn(async (_id: string, _file: string) => ''),
    archiveGeneration: vi.fn(async (): Promise<string | null> => null),
    restoreBackup: vi.fn(async (_id: string) => ({ safetyBackupPath: '/safety/meetings.sqlite' })),
  };
}
async function setup() {
  const app = Fastify({ logger: false });
  const repository = repo();
  await registerMeetings(app, { repository: repository as unknown as MeetingRepository });
  return { app, repository };
}
describe('local meeting archive access and writer ownership', () => {
  it('publishes managed identity and refuses writes from a different or missing build/workspace', async () => {
    const app = Fastify({ logger: false });
    const repository = repo();
    const identity = { workspaceId: 'workspace-a', buildId: 'build-a' };
    await registerMeetings(app, {
      repository: repository as unknown as MeetingRepository,
      serviceIdentity: identity,
    });
    try {
      const boot = (
        await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} })
      ).json();
      expect(boot.serviceIdentity).toEqual(identity);
      const headers = {
        authorization: `Bearer ${boot.token}`,
        'x-meeting-workspace': identity.workspaceId,
        'x-meeting-build': identity.buildId,
      };
      for (const candidate of [
        { authorization: headers.authorization },
        { ...headers, 'x-meeting-build': 'other' },
        { ...headers, 'x-meeting-workspace': 'other' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/meetings/lease',
          headers: candidate,
          payload: { writerId, ownerId },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toBe('SERVICE_IDENTITY_MISMATCH');
      }
      const lease = await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers,
        payload: { writerId, ownerId },
      });
      expect(lease.statusCode).toBe(200);
      expect(repository.commitEvents).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('refuses restore during an admitted write and releases admission after restore failure', async () => {
    const { app, repository } = await setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const auth = { authorization: `Bearer ${boot.json().token}` };
      const lease = await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers: auth,
        payload: { writerId, ownerId },
      });
      const headers = { ...auth, 'x-meeting-lease': lease.json().leaseToken };
      const payload = {
        meetingId,
        title: 'original',
        createdAt: new Date().toISOString(),
        captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
      };
      repository.createMeeting.mockImplementationOnce(async (value) => {
        entered();
        await gate;
        return value;
      });
      const writing = app
        .inject({ method: 'POST', url: '/meetings', headers, payload })
        .then((response) => response);
      await started;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/restore',
            headers,
            payload: { backupId: 'backup-' + writerId },
          })
        ).json().error,
      ).toBe('ARCHIVE_BUSY');
      expect(repository.restoreBackup).not.toHaveBeenCalled();
      finish();
      expect((await writing).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/restore',
            headers,
            payload: { backupId: '../escape' },
          })
        ).statusCode,
      ).toBe(400);
      repository.restoreBackup.mockRejectedValueOnce(new Error('ARCHIVE_BACKUP_HASH_MISMATCH'));
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/restore',
            headers,
            payload: { backupId: 'backup-' + writerId },
          })
        ).statusCode,
      ).toBe(503);
      expect(
        (await app.inject({ method: 'POST', url: '/meetings', headers, payload })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/meetings/lease/renew', headers, payload: {} }))
          .statusCode,
      ).toBe(200);
    } finally {
      finish?.();
      await app.close();
    }
  });
  it('restores only with writer ownership, revokes the lease and rejects overlapping writes', async () => {
    const { app, repository } = await setup();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const headers = { authorization: `Bearer ${boot.json().token}` };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/restore',
            headers,
            payload: { backupId: 'backup-' + writerId },
          })
        ).statusCode,
      ).toBe(409);
      expect(repository.restoreBackup).not.toHaveBeenCalled();
      const granted = await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers,
        payload: { writerId, ownerId },
      });
      const owned = { ...headers, 'x-meeting-lease': granted.json().leaseToken };
      repository.restoreBackup.mockImplementation(async () => {
        entered();
        await gate;
        repository.archiveGeneration.mockResolvedValue(meetingId);
        return { safetyBackupPath: '/safety/meetings.sqlite' };
      });
      const restoring = app
        .inject({
          method: 'POST',
          url: '/meetings/restore',
          headers: owned,
          payload: { backupId: 'backup-' + writerId },
        })
        .then((response) => response);
      await started;
      expect(
        (await app.inject({ method: 'POST', url: '/meetings', headers: owned, payload: {} })).json()
          .error,
      ).toBe('ARCHIVE_RESTORING');
      finish();
      const restored = await restoring;
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({
        archiveGeneration: meetingId,
        safetyBackupPath: '/safety/meetings.sqlite',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/lease/renew',
            headers: { ...owned, 'x-meeting-generation': meetingId },
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      expect(repository.createMeeting).not.toHaveBeenCalled();
    } finally {
      finish?.();
      await app.close();
    }
  });
  it('renews an admitted writer while the database is unresponsive', async () => {
    const { app, repository } = await setup();
    try {
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const headers = { authorization: `Bearer ${boot.json().token}` };
      const lease = await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers,
        payload: { writerId, ownerId },
      });
      repository.archiveGeneration.mockClear().mockRejectedValue(new Error('ARCHIVE_TIMEOUT'));
      const response = await app.inject({
        method: 'POST',
        url: '/meetings/lease/renew',
        headers: { ...headers, 'x-meeting-lease': lease.json().leaseToken },
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      expect(repository.archiveGeneration).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/lease/renew',
            headers: {
              ...headers,
              'x-meeting-lease': lease.json().leaseToken,
              'x-meeting-generation': meetingId,
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('rejects stale generations even with a valid prior lease and exposes the current generation', async () => {
    const { app, repository } = await setup();
    try {
      const bootstrap = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const headers = { authorization: `Bearer ${bootstrap.json().token}` };
      const lease = await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers,
        payload: { writerId, ownerId },
      });
      expect(lease.statusCode).toBe(200);
      repository.archiveGeneration.mockResolvedValue(meetingId);
      const oldHeaders = { ...headers, 'x-meeting-lease': lease.json().leaseToken };
      const stale = await app.inject({
        method: 'POST',
        url: '/meetings',
        headers: oldHeaders,
        payload: {},
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: 'ARCHIVE_GENERATION_MISMATCH' });
      expect(repository.createMeeting).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/lease',
            headers,
            payload: { writerId, ownerId },
          })
        ).statusCode,
      ).toBe(409);
      const fresh = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      expect(fresh.json().archiveGeneration).toBe(meetingId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/lease',
            headers: { ...headers, 'x-meeting-generation': meetingId },
            payload: { writerId, ownerId },
          })
        ).statusCode,
      ).toBe(200);
      repository.archiveGeneration.mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/meetings/lease',
            headers: { ...headers, 'x-meeting-generation': meetingId },
            payload: { writerId, ownerId },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('streams backup artifacts only to authorized local readers with bounded identifiers', async () => {
    const { app, repository } = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'backup-download-'));
    const path = join(dir, 'meetings.sqlite');
    const bytes = Buffer.from('SQLite controlled artifact bytes');
    await writeFile(path, bytes);
    repository.backupFile.mockResolvedValue(path);
    const backupId = 'backup-' + writerId;
    try {
      expect(
        (await app.inject({ method: 'GET', url: `/meetings/backups/${backupId}/meetings.sqlite` }))
          .statusCode,
      ).toBe(401);
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const headers = { authorization: `Bearer ${boot.json().token}` };
      const response = await app.inject({
        method: 'GET',
        url: `/meetings/backups/${backupId}/meetings.sqlite`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toContain('attachment;');
      expect(repository.backupFile).toHaveBeenCalledWith(backupId, 'meetings.sqlite');
      for (const url of [
        `/meetings/backups/invalid/meetings.sqlite`,
        `/meetings/backups/${backupId}/secrets`,
        `/meetings/backups/${backupId}/..%2Fsecret`,
      ])
        expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(400);
      expect(repository.backupFile).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('authorizes and bounds revision discovery without requiring a writer lease', async () => {
    const { app, repository } = await setup();
    try {
      expect(
        (await app.inject({ method: 'GET', url: `/meetings/${meetingId}/revisions` })).statusCode,
      ).toBe(401);
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      const headers = { authorization: `Bearer ${boot.json().token}` };
      const result = await app.inject({
        method: 'GET',
        url: `/meetings/${meetingId}/revisions?offset=2&limit=1`,
        headers,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ revisions: [], nextOffset: null });
      expect(repository.readRevisions).toHaveBeenCalledWith(meetingId, 2, 1);
      for (const query of ['limit=201', 'offset=-1', 'limit=1.5', 'offset=NaN'])
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/meetings/${meetingId}/revisions?${query}`,
              headers,
            })
          ).statusCode,
        ).toBe(400);
      expect(repository.readRevisions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it('reports an unsupported request format as 415 without claiming a storage failure', async () => {
    const { app, repository } = await setup();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/local/bootstrap',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'probe=1',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({ error: 'UNSUPPORTED_ARCHIVE_CONTENT_TYPE' });
      expect(repository.listMeetings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('pins an archive directory to its service instance even if process configuration later changes', async () => {
    const previous = process.env.MEETING_DATA_DIR;
    process.env.MEETING_DATA_DIR = 'C:/Develop/meeting_audio/.cache/archive-owner-a';
    const { app } = await setup();
    try {
      process.env.MEETING_DATA_DIR = 'C:/Develop/meeting_audio/.cache/archive-owner-b';
      const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
      expect(boot.json().dataDirectory.replaceAll('\\', '/')).toContain('archive-owner-a');
    } finally {
      if (previous === undefined) delete process.env.MEETING_DATA_DIR;
      else process.env.MEETING_DATA_DIR = previous;
      await app.close();
    }
  });
  it('requires loopback trusted origin for bootstrap, authentication for reads', async () => {
    const { app, repository } = await setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/local/bootstrap',
          payload: {},
          headers: { origin: 'https://attacker.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/local/bootstrap',
          payload: {},
          remoteAddress: '192.168.1.4',
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject('/meetings')).statusCode).toBe(401);
    expect(repository.listMeetings).not.toHaveBeenCalled();
    await app.close();
  });
  it('returns no-store bootstrap and permits authenticated read-only access', async () => {
    const { app } = await setup();
    const boot = await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} });
    expect(boot.statusCode).toBe(200);
    expect(boot.headers['cache-control']).toBe('no-store');
    const r = await app.inject({
      url: '/meetings',
      headers: { authorization: `Bearer ${boot.json().token}` },
    });
    expect(r.json()).toEqual({ meetings: [], exportFailure: false });
    await app.close();
  });
  it('keeps a second tab read-only and requires the actual lease token for mutation', async () => {
    const { app, repository } = await setup();
    const token = (
      await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} })
    ).json().token;
    const headers = { authorization: `Bearer ${token}` };
    const lease = await app.inject({
      method: 'POST',
      url: '/meetings/lease',
      headers,
      payload: { writerId, ownerId },
    });
    expect(lease.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/meetings/lease',
      headers,
      payload: { writerId, ownerId: meetingId },
    });
    expect(second.statusCode).toBe(409);
    const metadata = {
      meetingId,
      title: '測試',
      createdAt: new Date().toISOString(),
      captionTask: {
        purpose: 'transcription',
        inputLanguages: ['zh-tw', 'en'],
        textPolicy: 'zh-TW-preserve-original',
      },
    };
    expect(
      (await app.inject({ method: 'POST', url: '/meetings', headers, payload: metadata }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/meetings',
          headers: { ...headers, 'x-meeting-lease': lease.json().leaseToken },
          payload: metadata,
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.createMeeting).toHaveBeenCalledOnce();
    await app.close();
  });
  it('rejects a wrong meeting or writer envelope and traversal', async () => {
    const { app, repository } = await setup();
    const token = (
      await app.inject({ method: 'POST', url: '/local/bootstrap', payload: {} })
    ).json().token;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    headers['x-meeting-lease'] = (
      await app.inject({
        method: 'POST',
        url: '/meetings/lease',
        headers,
        payload: { writerId, ownerId },
      })
    ).json().leaseToken;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/meetings/${meetingId}/events`,
          headers,
          payload: { events: [{ meetingId: ownerId }] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/meetings/not-a-uuid', headers })).statusCode).toBe(400);
    expect(repository.commitEvents).not.toHaveBeenCalled();
    await app.close();
  });
});
