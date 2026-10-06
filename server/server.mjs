// Image Flattener self-hosted server (Docker / NAS).
//
// - Serves the built app (dist/).
// - Stores projects (.ifproj) and small app state (e.g. "My filaments") in DATA_DIR.
// - Relays read-only requests to a Spoolman instance (SPOOLMAN_URL, or the
//   URL set in the app), which browsers can't call directly (no CORS by default,
//   and http from an https page is blocked).
//
// No dependencies: Node 20+ only.

import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PROJECT_EXT = '.ifproj';
const MAX_PROJECT_BYTES = 512 * 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const SPOOLMAN_TIMEOUT_MS = 8000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A project file name as stored on disk, or an error for anything unsafe. */
export function projectFileName(raw) {
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'Bad project name.');
  }
  if (!name.toLowerCase().endsWith(PROJECT_EXT)) name += PROJECT_EXT;
  const stem = name.slice(0, -PROJECT_EXT.length);
  // No path separators, control characters, or names Windows/SMB can't hold.
  if (!stem.trim() || stem.length > 120 || /[\\/:*?"<>|\x00-\x1f]/.test(stem) || stem.startsWith('.')) {
    throw new HttpError(400, 'Project names can\'t contain / \\ : * ? " < > | or start with a dot.');
  }
  return stem + PROJECT_EXT;
}

/** Normalize a Spoolman base URL ("host:7912" → "http://host:7912"); '' if empty. */
export function normalizeSpoolmanUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new HttpError(400, `"${s}" is not a valid URL.`);
  }
  // Spoolman's own UI URL often has a path (/spool/show/3); the API lives at the root
  // unless Spoolman runs under a base path, which users then include explicitly.
  const p = u.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  return `${u.protocol}//${u.host}${p}`;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function spoolmanError(err, base) {
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return base;
    }
  })();
  const code = err?.cause?.code ?? err?.code ?? '';
  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return `Spoolman at ${base} did not answer in time.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return host.endsWith('.local')
      ? `The server can't resolve "${host}". Names ending in .local use mDNS, which Docker containers usually can't see. Use the IP address instead (e.g. http://192.168.1.20:7912).`
      : `The server can't resolve "${host}". Check the Spoolman URL.`;
  }
  if ((err?.cause?.message ?? '') === 'bad port') return `Browsers and Node refuse to connect to port ${new URL(base).port} (a reserved port). Run Spoolman on a different port.`;
  if (code === 'ECONNREFUSED') return `Nothing is listening at ${base} (connection refused). Check the port and that Spoolman is running.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${host} is unreachable from the server.`;
  return `Could not reach Spoolman at ${base}: ${err?.cause?.message ?? err?.message ?? err}`;
}

/**
 * Create the request handler.
 * @param {{ dataDir: string, staticDir: string, spoolmanUrl?: string, basicAuth?: string, version?: string }} o
 */
export async function createApp(o) {
  const dataDir = path.resolve(o.dataDir);
  const projectsDir = path.join(dataDir, 'projects');
  const stateDir = path.join(dataDir, 'state');
  const configFile = path.join(dataDir, 'config.json');
  const staticDir = path.resolve(o.staticDir);
  const envSpoolman = normalizeSpoolmanUrl(o.spoolmanUrl ?? '');

  let storageError = null;
  try {
    await mkdir(projectsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await access(dataDir, constants.W_OK);
  } catch (err) {
    storageError = `The data folder ${dataDir} is not writable (${err.code ?? err.message}). On a NAS, give the container's user write access to the mapped folder.`;
  }

  let config = {};
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch {
    /* no saved config yet */
  }
  const spoolmanUrl = () => (typeof config.spoolmanUrl === 'string' && config.spoolmanUrl) || envSpoolman;

  const authHeader = o.basicAuth ? `Basic ${Buffer.from(o.basicAuth).toString('base64')}` : null;

  async function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  function requireStorage() {
    if (storageError) throw new HttpError(507, storageError);
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const [area, ...rest] = parts;
    const m = req.method;

    if (area === 'health' && m === 'GET') return json(res, 200, { ok: true });

    if (area === 'config') {
      if (m === 'GET') {
        return json(res, 200, {
          server: true,
          version: o.version ?? '',
          storage: { ok: !storageError, error: storageError },
          spoolman: { url: spoolmanUrl(), fromEnv: !config.spoolmanUrl && !!envSpoolman, envUrl: envSpoolman },
        });
      }
      if (m === 'PUT') {
        requireStorage();
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        if ('spoolmanUrl' in body) {
          const u = normalizeSpoolmanUrl(body.spoolmanUrl);
          config = { ...config, spoolmanUrl: u };
          if (!u) delete config.spoolmanUrl; // empty → fall back to SPOOLMAN_URL
        }
        await writeAtomic(configFile, JSON.stringify(config, null, 2));
        return json(res, 200, { spoolman: { url: spoolmanUrl(), fromEnv: !config.spoolmanUrl && !!envSpoolman, envUrl: envSpoolman } });
      }
    }

    if (area === 'spoolman') {
      // Read-only relay: GET /api/spoolman/<path> → <SPOOLMAN>/api/v1/<path>
      if (m !== 'GET') throw new HttpError(405, 'Only GET requests are relayed to Spoolman.');
      const base = spoolmanUrl();
      if (!base) throw new HttpError(404, 'No Spoolman URL is set. Set SPOOLMAN_URL for the container, or enter it in the app.');
      const sub = rest.map(encodeURIComponent).join('/');
      if (!/^[\w%-]+(\/[\w%-]+)*$/.test(sub)) throw new HttpError(400, 'Bad Spoolman path.');
      const target = `${base}/api/v1/${sub}${url.search}`;
      let r;
      try {
        r = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(SPOOLMAN_TIMEOUT_MS) });
      } catch (err) {
        return json(res, 502, { error: spoolmanError(err, base) });
      }
      const body = Buffer.from(await r.arrayBuffer());
      if (!r.ok) {
        return json(res, 502, { error: `Spoolman at ${base} answered ${r.status} ${r.statusText} for ${sub}. Is this the Spoolman address (it should open the Spoolman web UI)?` });
      }
      const type = r.headers.get('content-type') ?? '';
      if (!type.includes('json')) return json(res, 502, { error: `${base} answered, but not with Spoolman data. Is this the Spoolman address?` });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length });
      return res.end(body);
    }

    if (area === 'projects') {
      requireStorage();
      if (rest.length === 0 && m === 'GET') {
        const names = (await readdir(projectsDir)).filter((n) => n.toLowerCase().endsWith(PROJECT_EXT) && !n.startsWith('.'));
        const list = [];
        for (const name of names) {
          try {
            const s = await stat(path.join(projectsDir, name));
            if (s.isFile()) list.push({ name, size: s.size, modified: s.mtime.toISOString() });
          } catch {
            /* removed meanwhile */
          }
        }
        list.sort((a, b) => b.modified.localeCompare(a.modified));
        return json(res, 200, list);
      }
      if (rest.length === 1) {
        const name = projectFileName(rest[0]);
        const file = path.join(projectsDir, name);
        if (m === 'GET') {
          let s;
          try {
            s = await stat(file);
          } catch {
            throw new HttpError(404, `No project named "${name}".`);
          }
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': s.size,
            'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          });
          return pipeline(createReadStream(file), res);
        }
        if (m === 'PUT') {
          const len = Number(req.headers['content-length'] ?? 0);
          if (len > MAX_PROJECT_BYTES) throw new HttpError(413, 'Project is too large.');
          const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
          let size = 0;
          try {
            await pipeline(
              req,
              async function* (src) {
                for await (const c of src) {
                  size += c.length;
                  if (size > MAX_PROJECT_BYTES) throw new HttpError(413, 'Project is too large.');
                  yield c;
                }
              },
              createWriteStream(tmp),
            );
            // Must at least look like a zip (PK\x03\x04).
            const head = Buffer.alloc(4);
            const fh = await open(tmp);
            await fh.read(head, 0, 4, 0);
            await fh.close();
            if (head.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'Not a project file.');
            await rename(tmp, file);
          } catch (err) {
            await rm(tmp, { force: true });
            throw err;
          }
          const s = await stat(file);
          return json(res, 200, { name, size: s.size, modified: s.mtime.toISOString() });
        }
        if (m === 'DELETE') {
          await rm(file, { force: true });
          return json(res, 200, { deleted: name });
        }
      }
    }

    if (area === 'state' && rest.length === 1 && /^[a-z0-9-]{1,40}$/.test(rest[0])) {
      requireStorage();
      const file = path.join(stateDir, `${rest[0]}.json`);
      if (m === 'GET') {
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
          return res.end(data);
        } catch {
          return json(res, 200, null); // not set yet
        }
      }
      if (m === 'PUT') {
        const body = await readBody(req, MAX_STATE_BYTES);
        try {
          JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Expected JSON.');
        }
        await writeAtomic(file, body);
        return json(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'Unknown API endpoint.');
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(staticDir, rel);
    if (file !== staticDir && !file.startsWith(staticDir + path.sep)) throw new HttpError(404, 'Not found.');
    let s;
    try {
      s = await stat(file);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    if (!s.isFile()) throw new HttpError(404, 'Not found.');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': s.size,
      // Vite fingerprints everything under assets/; the page itself must revalidate.
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(file), res);
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (authHeader && url.pathname !== '/api/health' && req.headers.authorization !== authHeader) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Image Flattener"' });
        return res.end('Authentication required.');
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err.message || 'Server error.' });
      else res.destroy();
    }
  };
}

export async function startServer(o) {
  const handler = await createApp(o);
  const server = createHttpServer(handler);
  await new Promise((resolve) => server.listen(o.port ?? 8080, o.host ?? '0.0.0.0', resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const version = await readFile(path.join(here, '..', 'package.json'), 'utf8')
    .then((t) => JSON.parse(t).version)
    .catch(() => '');
  const o = {
    port: Number(process.env.PORT ?? 8080),
    dataDir: process.env.DATA_DIR ?? path.join(here, '..', 'data'),
    staticDir: process.env.STATIC_DIR ?? path.join(here, '..', 'dist'),
    spoolmanUrl: process.env.SPOOLMAN_URL ?? '',
    basicAuth: process.env.BASIC_AUTH || undefined,
    version,
  };
  const server = await startServer(o);
  const addr = server.address();
  console.log(`Image Flattener on http://0.0.0.0:${addr.port}  data: ${path.resolve(o.dataDir)}  spoolman: ${o.spoolmanUrl || '(not set)'}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
