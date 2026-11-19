import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const staging = mkdtempSync(path.join(tmpdir(), 'meeting launch '));
mkdirSync(path.join(staging, 'server/dist'), { recursive: true });
writeFileSync(
  path.join(staging, 'server/dist/server.bundle.cjs'),
  'console.log("BUNDLE_STARTED");',
);
for (const name of ['start.bat', 'start.sh']) {
  writeFileSync(
    path.join(staging, name),
    readFileSync(path.join(root, 'scripts/release-templates', name)),
  );
}
afterAll(() => rmSync(staging, { recursive: true, force: true }));
const keyNames = ['OPENAI_API_KEY', 'OPENAI_API_KEY_AUDIO', 'GEMINI_API_KEY'] as const;
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

describe.each([
  { name: 'Windows', available: process.platform === 'win32', file: 'start.bat' },
  { name: 'Bash', available: existsSync(bash), file: 'start.sh' },
])('$name release launcher', ({ name, available, file }) => {
  it.skipIf(!available).each([...keyNames, 'none'])(
    'handles %s without leaking values',
    (selected) => {
      const env = { ...process.env };
      env.ONLINE_PORT = '8790';
      for (const key of keyNames) delete env[key];
      if (selected !== 'none') env[selected] = 'test-credential-never-print';
      const result =
        name === 'Windows'
          ? // Spell the script out in full: shells started with
            // NoDefaultCurrentDirectoryInExePath set (Git Bash does this) do not
            // search the working directory for a bare command name.
            spawnSync('cmd.exe', ['/d', '/c', path.join(staging, file)], {
              cwd: staging,
              env,
              encoding: 'utf8',
              input: '\n',
              timeout: 10_000,
            })
          : spawnSync(bash, [file], { cwd: staging, env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      expect(output).not.toContain('test-credential-never-print');
      if (selected === 'none') {
        expect(result.status).toBe(1);
        expect(output).not.toContain('BUNDLE_STARTED');
      } else {
        expect(output).toContain('BUNDLE_STARTED');
        expect(output).toContain('http://localhost:8790');
        expect(result.status).toBe(0);
      }
    },
  );
});
