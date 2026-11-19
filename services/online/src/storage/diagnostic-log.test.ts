import { expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticLog } from './diagnostic-log.js';
it('persists only diagnostic whitelist fields and rotates within the cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-log-'));
  try {
    const log = createDiagnosticLog(dir, { maxBytes: 512 });
    const expired = 'archive-1-12345678-1234-1234-1234-123456789abc.jsonl';
    await writeFile(join(dir, 'diagnostics', expired), 'expired');
    for (let i = 0; i < 20; i++)
      log.record({
        method: 'commitEvents',
        time: '2026-10-08T00:00:00.000Z',
        meetingId: '9e786acf-927c-466b-a8ed-39702b644cc8',
        eventCount: 3,
        errorCode: 'ARCHIVE_FAILURE',
        rawText: 'secret transcript',
        apiKey: 'secret-key',
      });
    const files = await readdir(join(dir, 'diagnostics'));
    expect(files).not.toContain(expired);
    const content = (
      await Promise.all(files.map((f) => readFile(join(dir, 'diagnostics', f), 'utf8')))
    ).join('');
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(512);
    expect(content).toContain('commitEvents');
    expect(content).not.toContain('secret');
    expect(JSON.parse(content.trim().split('\n').at(-1)!)).toMatchObject({
      eventCount: 3,
      errorCode: 'ARCHIVE_FAILURE',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
