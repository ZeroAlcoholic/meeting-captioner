import { expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { e2eTempDir } from './e2e-temp.mjs';
import { registerMeetings } from '../../services/online/src/routes/meetings.js';
import { MeetingRepository } from '../../services/online/src/storage/meeting-repository.js';

const require = createRequire(new URL('../../services/online/package.json', import.meta.url));
const Fastify = require('fastify');
const { build } = require('esbuild');

export async function storageFixture(trustedOrigins: string[] = [], sqliteFault = false) {
  const root = await e2eTempDir('storage-fault-');
  const workerPath = join(root, 'worker.cjs');
  const faultFlag = join(root, 'sqlite-fault');
  const faultLog = join(root, 'sqlite-fault.log');
  await build({
    entryPoints: ['services/online/src/storage/meeting-writer.worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: workerPath,
    // Test bundle only: exercise native FULL and separately inject IOERR at COMMIT.
    banner: sqliteFault
      ? {
          js: `
      const faultFs = require('node:fs');
      const faultPath = ${JSON.stringify(faultFlag)};
      const faultLog = ${JSON.stringify(faultLog)};
      const NativeSqlite = require('node:sqlite').DatabaseSync;
      require('node:sqlite').DatabaseSync = class extends NativeSqlite {
        exec(sql) {
          const fault = faultFs.existsSync(faultPath) ? faultFs.readFileSync(faultPath, 'utf8') : '';
          if (sql === 'BEGIN IMMEDIATE') {
            if (fault === 'worker_exit' || fault === 'worker_hang') {
              faultFs.appendFileSync(faultLog, fault + '\\n');
              if (fault === 'worker_exit') process.exit(23);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
            const limit = fault === 'full' ? super.prepare('PRAGMA page_count').get().page_count : 4294967294;
            super.exec('PRAGMA max_page_count=' + limit);
          }
          if (sql === 'COMMIT' && fault === 'ioerr') {
            faultFs.appendFileSync(faultLog, 'injected SQLITE_IOERR at COMMIT\\n');
            throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
          }
          return super.exec(sql);
        }
        prepare(sql) {
          const statement = super.prepare(sql);
          const run = statement.run;
          statement.run = function (...args) {
            try { return run.apply(this, args); }
            catch (error) {
              if (error.errcode === 13) faultFs.appendFileSync(faultLog, 'native SQLITE_FULL\\n');
              throw error;
            }
          };
          return statement;
        }
      };
    `,
        }
      : undefined,
  });
  const repository = new MeetingRepository({ dataDir: root, workerPath });
  const app = Fastify({ logger: false });
  // Pin the route's restart destination too, not just the initially injected worker.
  const previousDataDir = process.env.MEETING_DATA_DIR;
  process.env.MEETING_DATA_DIR = root;
  try {
    await registerMeetings(app, { repository, trustedOrigins });
  } finally {
    if (previousDataDir === undefined) delete process.env.MEETING_DATA_DIR;
    else process.env.MEETING_DATA_DIR = previousDataDir;
  }
  app.get(
    '/',
    (_request: unknown, reply: { type(value: string): { send(value: string): unknown } }) =>
      reply.type('text/html').send('<!doctype html><title>Storage fault fixture</title>'),
  );
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const bootstrap = await app.inject({ method: 'POST', url: '/local/bootstrap' });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().dataDirectory).toBe(root);
  } catch (error) {
    await app.close();
    await repository.close();
    throw error;
  }
  return { app, repository, url, root, faultFlag, faultLog };
}
