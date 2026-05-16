import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  ONLINE_PORT: 8787,
  ONLINE_HOST: '127.0.0.1',
  ONLINE_CORS_ORIGIN: 'http://localhost:5173',
  OPENAI_TIMEOUT_MS: 10_000,
  SESSION_RATE_LIMIT_PER_MIN: 30,
  SESSION_RENEW_MS: 25 * 60 * 1000,
  WEB_DIST_PATH: undefined as string | undefined,
}));

vi.mock('./config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import { _resetHealthForTests } from './routes/healthz.js';
import { _resetRateLimitForTests } from './routes/session.js';
import { buildApp } from './server.js';

beforeEach(() => {
  _resetHealthForTests();
  _resetRateLimitForTests();
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.WEB_DIST_PATH = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('online service', () => {
  it('GET /healthz reports structured components when key present', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-test';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ok: boolean;
      service: string;
      version: string;
      components: { apiKey: string; openai_reachability: string };
    }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('online');
    expect(body.components.apiKey).toBe('configured');
    expect(body.components.openai_reachability).toBe('unknown');
    await app.close();
  });

  it('GET /healthz reports ok=false when key missing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; components: { apiKey: string } }>();
    expect(body.ok).toBe(false);
    expect(body.components.apiKey).toBe('missing');
    await app.close();
  });

  it('GET /session/info returns hasApiKey + renewal hint', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/session/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hasApiKey: boolean; sessionRenewalRecommendedMs: number }>();
    expect(body.hasApiKey).toBe(false);
    expect(body.sessionRenewalRecommendedMs).toBeGreaterThan(0);
    await app.close();
  });

  it('POST /session returns 503 when OPENAI_API_KEY absent', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/session' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('does NOT import dotenv (strict system-env-only policy)', async () => {
    // Robustness against regression: dotenv was intentionally removed in
    // P3.10 so the slim release reads OPENAI_API_KEY from system env only.
    // If anyone adds dotenv back without an explicit policy review, this
    // test fails.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.dotenv).toBeUndefined();
    expect(pkg.devDependencies?.dotenv).toBeUndefined();

    const configSrc = fs.readFileSync(
      path.resolve(__dirname, 'config.ts'),
      'utf8',
    );
    expect(configSrc).not.toMatch(/from\s+['"]dotenv['"]/);
    expect(configSrc).not.toMatch(/require\(\s*['"]dotenv['"]\s*\)/);
  });

  describe('static SPA fallback (slim release)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      tmpDir = mkdtempSync(join(tmpdir(), 'meeting-audio-static-'));
      writeFileSync(join(tmpDir, 'index.html'), '<!DOCTYPE html><html><body>OK</body></html>');
      mkdirSync(join(tmpDir, 'assets'));
      writeFileSync(join(tmpDir, 'assets', 'app.js'), 'console.log("hello")');
      mockConfig.WEB_DIST_PATH = tmpDir;
    });

    afterEach(async () => {
      const { rmSync } = await import('node:fs');
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('GET / serves index.html', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<html>');
      await app.close();
    });

    it('GET /deep/route falls back to index.html (SPA)', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/deep/route' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<html>');
      await app.close();
    });

    it('GET /assets/missing.js returns 404 (NOT index.html)', async () => {
      // Robustness: a missing hashed asset must return 404, not the HTML
      // fallback — otherwise the browser parses HTML as JS and SyntaxErrors.
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/assets/missing.js' });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<html>');
      await app.close();
    });

    it.each([
      '/favicon.ico',
      '/robots.txt',
      '/sitemap.xml',
      '/something.map',
      '/foo/bar.png',
    ])('GET %s returns 404 (file-ext heuristic; not SPA fallback)', async (path) => {
      // Caught in Phase D: GET /favicon.ico used to return HTML (the
      // index.html fallback), which the browser then warned about as a
      // content-type mismatch. The heuristic: any path whose final segment
      // looks like a file (has an extension) must be a real 404 if not on
      // disk, never the SPA fallback.
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<html>');
      await app.close();
    });

    it('GET /assets/app.js serves the actual asset', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('console.log');
      await app.close();
    });

    it('GET /healthz still works (NOT shadowed by SPA fallback)', async () => {
      mockConfig.OPENAI_API_KEY = 'sk-test';
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ ok: boolean }>().ok).toBe(true);
      await app.close();
    });

    it('POST /unknown returns 404 (NOT index.html)', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'POST', url: '/unknown' });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('serves large static assets with gzip when client accepts it', async () => {
      // Robustness: assets >= 1 KB must be served gzipped if the client
      // advertises Accept-Encoding: gzip. Verifies the @fastify/compress
      // registration; caught in Phase E when /assets/JS was returning
      // 1.36 MB raw to a gzip-capable client.
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(join(tmpDir, 'assets'), { recursive: true });
      writeFileSync(join(tmpDir, 'assets', 'big.js'), 'x'.repeat(20_000));
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/assets/big.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      // 20 KB of 'x' compresses to ~50 bytes; allow some slack.
      const payloadSize = Buffer.isBuffer(res.rawPayload)
        ? res.rawPayload.length
        : Buffer.byteLength(String(res.payload));
      expect(payloadSize).toBeLessThan(5_000);
      await app.close();
    });
  });
});
