import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Readable } from 'node:stream';
import {
  FinalizeInput,
  MeetingEnvelope,
  MeetingMetadata,
  type ArchiveServiceIdentity,
} from '@meeting-audio/contracts';
import { MeetingRepository, meetingDataDir } from '../storage/meeting-repository.js';

declare const __ARCHIVE_WORKER_PATH__: string;
const Id = z.string().uuid();
const LeaseInput = z.object({ writerId: Id, ownerId: Id }).strict();
const Batch = z.object({ events: z.array(MeetingEnvelope).min(1).max(100) }).strict();
const LEASE_MS = 15_000;
function sameSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function loopback(value: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(value);
}
function trustedRequest(req: FastifyRequest, trustedOrigins: string[]): boolean {
  if (!loopback(req.ip)) return false;
  let host: URL;
  try {
    host = new URL(`http://${req.headers.host ?? ''}`);
  } catch {
    return false;
  }
  if (!loopback(host.hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  return origin === host.origin || trustedOrigins.includes(origin);
}
function defaultRepository(dataDir: string): MeetingRepository {
  const workerPath =
    typeof __ARCHIVE_WORKER_PATH__ !== 'undefined'
      ? resolve(__dirname, __ARCHIVE_WORKER_PATH__)
      : fileURLToPath(new URL('../../dist/meeting-writer.worker.cjs', import.meta.url));
  if (!existsSync(workerPath)) throw new Error('ARCHIVE_WORKER_MISSING');
  return new MeetingRepository({
    dataDir,
    workerPath,
  });
}

/** Loopback-only local archive. CORS is not authorization; every read and write needs a local token. */
export async function registerMeetings(
  app: FastifyInstance,
  options: {
    repository?: MeetingRepository;
    trustedOrigins?: string[];
    serviceIdentity?: ArchiveServiceIdentity;
  } = {},
): Promise<void> {
  const token = randomBytes(32).toString('hex');
  const dataDirectory = process.env.MEETING_DATA_DIR
    ? resolve(process.env.MEETING_DATA_DIR)
    : meetingDataDir();
  let repository = options.repository;
  let opening: Promise<MeetingRepository> | null = null;
  let lastRestart = 0;
  const getRepository = async (): Promise<MeetingRepository> => {
    if (repository && !repository.failed) return repository;
    if (opening) return opening;
    opening = (async () => {
      if (lastRestart && Date.now() - lastRestart < 1000)
        throw new Error('ARCHIVE_RECOVERY_COOLDOWN');
      lastRestart = Date.now();
      await repository?.close();
      repository = defaultRepository(dataDirectory);
      // Recovery validates the DB in the worker, then rebuilds derived files left stale by a crash.
      const meetings = await repository.listMeetings();
      for (const meeting of meetings) dirty.add(meeting.meetingId);
      return repository;
    })().finally(() => {
      opening = null;
    });
    return opening;
  };
  let lease: {
    writerId: string;
    ownerId: string;
    leaseToken: string;
    expiresAt: number;
    generation: string | null;
  } | null = null;
  const dirty = new Set<string>();
  let restoring = false;
  let activeWrites = 0;
  let refreshPromise: Promise<void> | null = null;
  let exportFailure = false;
  const refresh = (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    if (restoring) return Promise.resolve();
    if (!repository) return Promise.resolve();
    refreshPromise = (async () => {
      try {
        for (const id of [...dirty]) {
          dirty.delete(id);
          try {
            await (await getRepository()).refreshExports(id);
          } catch (error) {
            dirty.add(id);
            throw error;
          }
        }
        exportFailure = false;
      } catch {
        exportFailure = true;
        app.log.warn('Local transcript export refresh failed');
      }
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };
  const timer = setInterval(() => void refresh(), 30_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await refresh();
    await repository?.close();
  });
  const ensureLease = (req: FastifyRequest) =>
    lease !== null &&
    lease.expiresAt > Date.now() &&
    sameSecret(req.headers['x-meeting-lease'], lease.leaseToken);

  await app.register(async (local) => {
    local.addContentTypeParser('application/octet-stream', (req, payload, done) => {
      if (req.url.split('?')[0] !== '/meetings/backups/import')
        return done(
          Object.assign(new Error('UNSUPPORTED_ARCHIVE_CONTENT_TYPE'), { statusCode: 415 }),
        );
      done(null, payload);
    });
    local.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!trustedRequest(req, options.trustedOrigins ?? []))
        return reply.code(403).send({ error: 'LOCAL_ORIGIN_REQUIRED' });
      if (req.url.split('?')[0] === '/local/bootstrap') return;
      if (!sameSecret(req.headers.authorization, `Bearer ${token}`))
        return reply.code(401).send({ error: 'LOCAL_AUTH_REQUIRED' });
      if (
        req.method !== 'GET' &&
        options.serviceIdentity &&
        (req.headers['x-meeting-workspace'] !== options.serviceIdentity.workspaceId ||
          req.headers['x-meeting-build'] !== options.serviceIdentity.buildId)
      )
        return reply.code(409).send({ error: 'SERVICE_IDENTITY_MISMATCH' });
    });
    // Own admission until the handler finishes, including disconnected callers.
    // This covers requests admitted before restore and avoids a generation-check race.
    local.addHook('onRoute', (route) => {
      if (route.method === 'GET' || route.url === '/local/bootstrap') return;
      const handler = route.handler;
      route.handler = async function (req, reply) {
        const isRestore = route.url === '/meetings/restore';
        if (restoring) return reply.code(409).send({ error: 'ARCHIVE_RESTORING' });
        if (isRestore && activeWrites) return reply.code(409).send({ error: 'ARCHIVE_BUSY' });
        activeWrites++;
        if (isRestore) restoring = true;
        try {
          // Renewal must keep working while the worker is hung. Mutations still
          // validate the current DB identity; restore will revoke the admitted lease.
          const generation =
            req.url === '/meetings/lease/renew'
              ? (lease?.generation ?? null)
              : await (await getRepository()).archiveGeneration();
          if ((req.headers['x-meeting-generation'] ?? null) !== generation)
            return reply.code(409).send({ error: 'ARCHIVE_GENERATION_MISMATCH' });
          if (route.url !== '/meetings/lease' && !ensureLease(req))
            return reply.code(409).send({ error: 'WRITER_LEASE_REQUIRED' });
          return await handler.call(this, req, reply);
        } finally {
          activeWrites--;
          if (isRestore) restoring = false;
        }
      };
    });
    local.setErrorHandler<Error & { statusCode?: number; validation?: unknown }>(
      (error, _req, reply) => {
        if (error.statusCode === 415)
          return reply.code(415).send({ error: 'UNSUPPORTED_ARCHIVE_CONTENT_TYPE' });
        const known = /^(ARCHIVE_|MEETING_|REVISION_|EVENT_|STALE_|INVALID_|WRITER_|SQLITE_)/.test(
          error.message,
        );
        const message = known
          ? (error.message.split(':')[0] ?? 'ARCHIVE_OPERATION_FAILED')
          : 'ARCHIVE_OPERATION_FAILED';
        const status =
          error.validation || error.statusCode === 413
            ? error.statusCode === 413
              ? 413
              : 400
            : /CONFLICT|REVISION|STALE|FINALIZED/.test(message)
              ? 409
              : /NOT_FOUND/.test(message)
                ? 404
                : 503;
        reply.code(status).send({ error: message });
      },
    );
    local.post('/local/bootstrap', async () => {
      // An actual DB query detects worker/runtime/storage errors before reporting available.
      await (await getRepository()).listMeetings();
      return {
        token,
        dataDirectory,
        storageAvailable: true,
        ...(options.serviceIdentity ? { serviceIdentity: options.serviceIdentity } : {}),
        exportFailure,
        archiveGeneration: await (await getRepository()).archiveGeneration(),
      };
    });
    local.post('/meetings/lease', async (req, reply) => {
      const parsed = LeaseInput.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_WRITER' });
      if (
        lease &&
        lease.expiresAt > Date.now() &&
        (lease.ownerId !== parsed.data.ownerId || lease.writerId !== parsed.data.writerId)
      )
        return reply.code(409).send({ error: 'ANOTHER_TAB_IS_WRITING' });
      lease = {
        ...parsed.data,
        generation: (req.headers['x-meeting-generation'] as string | undefined) ?? null,
        leaseToken:
          lease?.ownerId === parsed.data.ownerId
            ? lease.leaseToken
            : randomBytes(32).toString('hex'),
        expiresAt: Date.now() + LEASE_MS,
      };
      return { leaseToken: lease.leaseToken, expiresAt: lease.expiresAt };
    });
    local.post('/meetings/lease/renew', async () => {
      lease!.expiresAt = Date.now() + LEASE_MS;
      return { leaseToken: lease!.leaseToken, expiresAt: lease!.expiresAt, exportFailure };
    });
    local.post('/meetings/lease/release', async () => {
      lease = null;
      return { released: true };
    });
    local.get('/meetings', async () => ({
      meetings: await (await getRepository()).listMeetings(),
      exportFailure,
    }));
    local.post('/meetings', async (req, reply) => {
      const parsed = MeetingMetadata.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_MEETING' });
      return (await getRepository()).createMeeting(parsed.data);
    });
    local.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
      '/meetings/:id',
      async (req, reply) => {
        if (!Id.safeParse(req.params.id).success)
          return reply.code(400).send({ error: 'INVALID_MEETING_ID' });
        const offset = Number(req.query.offset ?? 0),
          limit = Number(req.query.limit ?? 200);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200
        )
          return reply.code(400).send({ error: 'INVALID_PAGE' });
        return (await getRepository()).readPage(req.params.id, offset, limit);
      },
    );
    local.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
      '/meetings/:id/revisions',
      async (req, reply) => {
        if (!Id.safeParse(req.params.id).success)
          return reply.code(400).send({ error: 'INVALID_MEETING_ID' });
        const offset = Number(req.query.offset ?? 0),
          limit = Number(req.query.limit ?? 200);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200
        )
          return reply.code(400).send({ error: 'INVALID_PAGE' });
        return (await getRepository()).readRevisions(req.params.id, offset, limit);
      },
    );
    local.post<{ Params: { id: string } }>(
      '/meetings/:id/events',
      { bodyLimit: 256 * 1024 },
      async (req, reply) => {
        const parsed = Batch.safeParse(req.body);
        if (
          !Id.safeParse(req.params.id).success ||
          !parsed.success ||
          parsed.data.events.some(
            (e) => e.meetingId !== req.params.id || e.writerId !== lease!.writerId,
          )
        )
          return reply.code(400).send({ error: 'INVALID_MEETING_EVENTS' });
        const receipt = await (await getRepository()).commitEvents(parsed.data.events);
        dirty.add(req.params.id);
        return receipt;
      },
    );
    local.post<{ Params: { id: string } }>('/meetings/:id/finalize', async (req, reply) => {
      const parsed = FinalizeInput.safeParse(req.body);
      if (!Id.safeParse(req.params.id).success || !parsed.success)
        return reply.code(400).send({ error: 'INVALID_FINALIZATION' });
      const repo = await getRepository();
      const manifest = await repo.finalize(req.params.id, parsed.data);
      dirty.add(req.params.id);
      try {
        await repo.refreshExports(req.params.id);
        exportFailure = false;
      } catch {
        exportFailure = true;
      }
      return { ...manifest, exportFailure };
    });
    local.get<{ Params: { id: string }; Querystring: { variant?: string; format?: string } }>(
      '/meetings/:id/export',
      async (req, reply) => {
        const variant = z
          .enum(['original', 'corrected'])
          .safeParse(req.query.variant ?? 'corrected');
        const format = z.enum(['txt', 'json', 'srt']).safeParse(req.query.format ?? 'txt');
        if (!Id.safeParse(req.params.id).success || !variant.success || !format.success)
          return reply.code(400).send({ error: 'INVALID_EXPORT' });
        const text = await (await getRepository()).export(req.params.id, variant.data, format.data);
        return reply
          .header(
            'Content-Disposition',
            `attachment; filename="${req.params.id}-${variant.data}.${format.data}"`,
          )
          .type(
            format.data === 'json'
              ? 'application/json; charset=utf-8'
              : 'text/plain; charset=utf-8',
          )
          .send(text);
      },
    );
    local.post('/meetings/backup', async () => {
      const path = await (await getRepository()).backup();
      return { path, backupId: basename(dirname(path)) };
    });
    local.post('/meetings/restore', async (req, reply) => {
      const parsed = z
        .object({ backupId: z.string().regex(/^backup-[a-f0-9-]{36}$/), generation: Id.optional() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BACKUP_ID' });
      await refreshPromise;
      const repo = await getRepository();
      const result = await repo.restoreBackup(parsed.data.backupId, parsed.data.generation);
      lease = null;
      dirty.clear();
      for (const meeting of await repo.listMeetings()) dirty.add(meeting.meetingId);
      return { ...result, archiveGeneration: await repo.archiveGeneration() };
    });
    local.post('/meetings/backups/import', async (req, reply) => {
      const manifest = req.headers['x-meeting-backup-manifest'];
      if (typeof manifest !== 'string' || Buffer.byteLength(manifest) > 4096)
        return reply.code(400).send({ error: 'ARCHIVE_BACKUP_MANIFEST_INVALID' });
      if (!req.headers['content-type']?.startsWith('application/octet-stream'))
        return reply.code(415).send({ error: 'UNSUPPORTED_ARCHIVE_CONTENT_TYPE' });
      return {
        backupId: await (await getRepository()).importBackup(req.body as Readable, manifest),
      };
    });
    local.get<{ Params: { backupId: string; file: string } }>(
      '/meetings/backups/:backupId/:file',
      async (req, reply) => {
        const parsed = z
          .object({
            backupId: z.string().regex(/^backup-[a-f0-9-]{36}$/),
            file: z.enum(['meetings.sqlite', 'manifest.json']),
          })
          .safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BACKUP_FILE' });
        const { backupId, file } = parsed.data;
        const path = await (await getRepository()).backupFile(backupId, file);
        return reply
          .header('Content-Disposition', `attachment; filename="${file}"`)
          .type(file === 'manifest.json' ? 'application/json' : 'application/octet-stream')
          .send(createReadStream(path));
      },
    );
  });
}
