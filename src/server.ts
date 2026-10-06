import { spoolsToInventory, type SpoolmanInventory, type SpoolmanSpool } from './core/spoolman';

/**
 * Talks to the optional self-hosted server (server/server.mjs, e.g. in Docker
 * on a NAS). On static hosting (GitHub Pages) there is no server: every
 * feature here reports "unavailable" and the app works as before.
 */

export interface ServerConfig {
  server: true;
  version: string;
  storage: { ok: boolean; error: string | null };
  spoolman: SpoolmanConfig;
}

export interface SpoolmanConfig {
  /** Effective Spoolman base URL ('' = not set). */
  url: string;
  /** True when the URL comes from the container's SPOOLMAN_URL. */
  fromEnv: boolean;
  envUrl: string;
}

export interface ServerProject {
  name: string;
  size: number;
  modified: string;
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) return j.error;
  } catch {
    /* not JSON */
  }
  return `${r.status} ${r.statusText}`;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(path, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(await errorText(r));
  return r;
}

let configPromise: Promise<ServerConfig | null> | null = null;

/** True in the self-hosted build (npm run build:server, used by the Docker image). */
export const SELF_HOSTED = import.meta.env.VITE_SELF_HOSTED === '1';

/** The server's config, or null when the app is statically hosted. */
export function serverConfig(): Promise<ServerConfig | null> {
  // Static builds (GitHub Pages) never ask: there is no server to answer.
  if (!SELF_HOSTED) return Promise.resolve(null);
  configPromise ??= fetch('api/config', { cache: 'no-store' })
    .then(async (r) => {
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      const c = (await r.json()) as Partial<ServerConfig>;
      return c.server === true ? (c as ServerConfig) : null;
    })
    .catch(() => null);
  return configPromise;
}

export async function setSpoolmanUrl(url: string): Promise<SpoolmanConfig> {
  const r = await call('api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spoolmanUrl: url }) });
  const { spoolman } = (await r.json()) as { spoolman: SpoolmanConfig };
  const c = await serverConfig();
  if (c) c.spoolman = spoolman;
  return spoolman;
}

// ------------------------------------------------------------- Spoolman ----

export interface SpoolmanState extends SpoolmanInventory {
  url: string;
  loadedAt: Date;
}

let spoolmanPromise: Promise<SpoolmanState | null> | null = null;

/**
 * Filaments on hand from Spoolman (cached; `refresh` re-reads). Resolves to
 * null when there is no server or no Spoolman URL; rejects with a readable
 * message when Spoolman can't be reached.
 */
export function spoolmanInventory(refresh = false): Promise<SpoolmanState | null> {
  if (refresh || !spoolmanPromise) {
    spoolmanPromise = (async () => {
      const c = await serverConfig();
      if (!c || !c.spoolman.url) return null;
      const r = await call('api/spoolman/spool?allow_archived=false');
      const spools = (await r.json()) as SpoolmanSpool[];
      if (!Array.isArray(spools)) throw new Error('Spoolman returned something unexpected.');
      return { ...spoolsToInventory(spools), url: c.spoolman.url, loadedAt: new Date() };
    })();
    // Don't cache failures: the next call retries.
    spoolmanPromise.catch(() => (spoolmanPromise = null));
  }
  return spoolmanPromise;
}

// ------------------------------------------------------------- projects ----

export async function listProjects(): Promise<ServerProject[]> {
  return (await (await call('api/projects')).json()) as ServerProject[];
}

export async function loadServerProject(name: string): Promise<Blob> {
  return (await call(`api/projects/${encodeURIComponent(name)}`)).blob();
}

export async function saveServerProject(name: string, blob: Blob): Promise<ServerProject> {
  const r = await call(`api/projects/${encodeURIComponent(name)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/zip' } });
  return (await r.json()) as ServerProject;
}

export async function deleteServerProject(name: string): Promise<void> {
  await call(`api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------- state ----

export async function getServerState<T>(key: string): Promise<T | null> {
  return (await (await call(`api/state/${key}`)).json()) as T | null;
}

export async function putServerState(key: string, value: unknown): Promise<void> {
  await call(`api/state/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
