import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeSpoolmanUrl, projectFileName, startServer } from './server.mjs';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const SPOOLS = [{ id: 1, remaining_weight: 500, filament: { id: 7, name: 'Black', material: 'PLA', color_hex: '000000', vendor: { name: 'Bambu Lab' } } }];

let tmp, server, base, spoolman, spoolmanUrl, lastSpoolmanPath;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'if-server-'));
  await mkdir(path.join(tmp, 'dist', 'assets'), { recursive: true });
  await writeFile(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(path.join(tmp, 'dist', 'assets', 'a-123.js'), 'console.log(1)');
  await writeFile(path.join(tmp, 'secret.txt'), 'nope');
  // Stub Spoolman.
  spoolman = createServer((req, res) => {
    lastSpoolmanPath = req.url;
    if (req.url.startsWith('/api/v1/spool')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(SPOOLS));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"detail":"Not Found"}');
  });
  await new Promise((r) => spoolman.listen(0, '127.0.0.1', r));
  spoolmanUrl = `http://127.0.0.1:${spoolman.address().port}`;
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'data'), staticDir: path.join(tmp, 'dist'), spoolmanUrl });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => spoolman.close(r));
  await rm(tmp, { recursive: true, force: true });
});

describe('static files', () => {
  it('serves the app with cache headers', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-cache');
    const a = await fetch(`${base}/assets/a-123.js`);
    expect(a.headers.get('cache-control')).toContain('immutable');
  });

  it('does not serve files outside the app folder', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
    }
  });
});

describe('config', () => {
  it('reports the server, storage and the Spoolman URL', async () => {
    const c = await (await fetch(`${base}/api/config`)).json();
    expect(c).toMatchObject({ server: true, storage: { ok: true }, spoolman: { url: spoolmanUrl, fromEnv: true } });
  });

  it('normalizes Spoolman URLs', () => {
    expect(normalizeSpoolmanUrl('theplace.local:7912')).toBe('http://theplace.local:7912');
    expect(normalizeSpoolmanUrl('http://theplace.local:7912/')).toBe('http://theplace.local:7912');
    expect(normalizeSpoolmanUrl('http://10.0.0.5:7912/api/v1')).toBe('http://10.0.0.5:7912');
    expect(normalizeSpoolmanUrl('https://nas/spoolman/')).toBe('https://nas/spoolman');
    expect(normalizeSpoolmanUrl('')).toBe('');
  });
});

describe('Spoolman relay', () => {
  it('relays GET requests to the Spoolman API', async () => {
    const r = await fetch(`${base}/api/spoolman/spool?allow_archived=false`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(SPOOLS);
    expect(lastSpoolmanPath).toBe('/api/v1/spool?allow_archived=false');
  });

  it('only relays GET', async () => {
    const r = await fetch(`${base}/api/spoolman/spool`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(405);
  });

  it('explains a URL that is not Spoolman', async () => {
    const r = await fetch(`${base}/api/spoolman/nothing`);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/answered 404/);
  });

  it('can be pointed elsewhere from the app, and explains unreachable hosts', async () => {
    // A port nothing listens on.
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const closed = `http://127.0.0.1:${probe.address().port}`;
    await new Promise((r) => probe.close(r));
    let r = await fetch(`${base}/api/config`, { method: 'PUT', body: JSON.stringify({ spoolmanUrl: closed }) });
    expect((await r.json()).spoolman).toMatchObject({ url: closed, fromEnv: false });
    r = await fetch(`${base}/api/spoolman/spool`);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/connection refused/);
    // Saved in the data folder.
    expect(JSON.parse(await readFile(path.join(tmp, 'data', 'config.json'), 'utf8')).spoolmanUrl).toBe(closed);
    // Empty → back to SPOOLMAN_URL.
    r = await fetch(`${base}/api/config`, { method: 'PUT', body: JSON.stringify({ spoolmanUrl: '' }) });
    expect((await r.json()).spoolman).toMatchObject({ url: spoolmanUrl, fromEnv: true });
  });
});

describe('projects', () => {
  it('saves, lists, loads and deletes projects', async () => {
    let r = await fetch(`${base}/api/projects/My%20heart`, { method: 'PUT', body: ZIP });
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe('My heart.ifproj');
    const list = await (await fetch(`${base}/api/projects`)).json();
    expect(list.map((p) => p.name)).toEqual(['My heart.ifproj']);
    r = await fetch(`${base}/api/projects/${encodeURIComponent('My heart.ifproj')}`);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(ZIP);
    r = await fetch(`${base}/api/projects/${encodeURIComponent('My heart.ifproj')}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([]);
  });

  it('rejects files that are not projects', async () => {
    const r = await fetch(`${base}/api/projects/x`, { method: 'PUT', body: 'hello' });
    expect(r.status).toBe(400);
    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([]);
  });

  it('rejects unsafe names', () => {
    for (const bad of ['..%2Fx', '%2Fetc%2Fpasswd', 'a%5Cb', '.hidden', '%20', 'a:b']) expect(() => projectFileName(bad)).toThrow();
    expect(projectFileName('Heart%20(v2)')).toBe('Heart (v2).ifproj');
  });

  it('answers 404 for a missing project', async () => {
    expect((await fetch(`${base}/api/projects/missing`)).status).toBe(404);
  });
});

describe('state', () => {
  it('stores small JSON documents', async () => {
    expect(await (await fetch(`${base}/api/state/my-filaments`)).json()).toBeNull();
    const v = { ids: ['db:a'], custom: [] };
    await fetch(`${base}/api/state/my-filaments`, { method: 'PUT', body: JSON.stringify(v) });
    expect(await (await fetch(`${base}/api/state/my-filaments`)).json()).toEqual(v);
    expect((await fetch(`${base}/api/state/x`, { method: 'PUT', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${base}/api/state/..%2Fconfig`)).status).toBe(404);
  });
});

describe('basic auth', () => {
  it('asks for a password when BASIC_AUTH is set', async () => {
    const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'data2'), staticDir: path.join(tmp, 'dist'), basicAuth: 'me:pw' });
    const b = `http://127.0.0.1:${s.address().port}`;
    expect((await fetch(`${b}/`)).status).toBe(401);
    expect((await fetch(`${b}/api/health`)).status).toBe(200);
    const ok = await fetch(`${b}/`, { headers: { Authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` } });
    expect(ok.status).toBe(200);
    await new Promise((r) => s.close(r));
  });
});
