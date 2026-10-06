import { downloadBlob } from './exporters';
import { deleteServerProject, listProjects, loadServerProject, type ServerProject } from './server';

/** Projects stored on the self-hosted server. */
export interface ProjectsDialogOptions {
  /** Suggested name for saving the current work; null when there's nothing to save. */
  saveName: string | null;
  save: (name: string) => Promise<void>;
  open: (blob: Blob, name: string) => Promise<void>;
  openLocal: () => void;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const stem = (name: string): string => name.replace(/\.ifproj$/i, '');

function size(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

let dialog: HTMLDialogElement | null = null;
let opts: ProjectsDialogOptions;
let projects: ServerProject[] = [];

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'filament-dialog projects-dialog';
  d.innerHTML = `
    <form method="dialog" class="fd-head">
      <h3>Projects on the server</h3>
      <span class="spacer"></span>
      <button value="close" aria-label="Close">✕</button>
    </form>
    <form class="pd-save row">
      <input class="pd-name" type="text" aria-label="Project name" placeholder="Project name" />
      <button type="submit" class="primary">Save current</button>
    </form>
    <div class="pd-status status"></div>
    <ul class="fd-list pd-list"></ul>
    <div class="fd-foot">
      <span class="hint">Stored in the container's /data folder.</span>
      <span class="spacer"></span>
      <button type="button" class="pd-local">Open from this computer…</button>
    </div>`;
  document.body.appendChild(d);
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.querySelector('.pd-local')!.addEventListener('click', () => {
    d.close();
    opts.openLocal();
  });
  d.querySelector<HTMLFormElement>('.pd-save')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = d.querySelector<HTMLInputElement>('.pd-name')!.value.trim();
    if (!name) return;
    const file = `${stem(name)}.ifproj`;
    if (projects.some((p) => p.name.toLowerCase() === file.toLowerCase()) && !confirm(`Replace the saved project "${stem(name)}"?`)) return;
    setStatus('Saving…');
    try {
      await opts.save(name);
      setStatus(`Saved "${stem(name)}".`);
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  });
  return d;
}

function setStatus(text: string, error = false): void {
  const el = dialog!.querySelector<HTMLElement>('.pd-status')!;
  el.textContent = text;
  el.classList.toggle('error', error);
}

async function refresh(): Promise<void> {
  const d = dialog!;
  const ul = d.querySelector('.pd-list')!;
  try {
    projects = await listProjects();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
    return;
  }
  ul.innerHTML = projects.length ? '' : '<li class="hint pd-empty">No projects saved on the server yet.</li>';
  for (const p of projects) {
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="fd-pick pd-open" title="Open this project">
        <span class="fd-text">
          <span class="fd-name">${esc(stem(p.name))}</span>
          <span class="fd-meta">${new Date(p.modified).toLocaleString()} · ${size(p.size)}</span>
        </span>
      </button>
      <button type="button" class="pd-dl" title="Download the .ifproj file">Download</button>
      <button type="button" class="pd-del" title="Delete from the server">Delete</button>`;
    const [open, dl, del] = li.querySelectorAll('button');
    open.addEventListener('click', async () => {
      setStatus(`Opening "${stem(p.name)}"…`);
      try {
        const blob = await loadServerProject(p.name);
        d.close();
        await opts.open(blob, p.name);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
    });
    dl.addEventListener('click', async () => {
      try {
        downloadBlob(await loadServerProject(p.name), p.name);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
    });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the project "${stem(p.name)}" from the server? This can't be undone.`)) return;
      try {
        await deleteServerProject(p.name);
        setStatus(`Deleted "${stem(p.name)}".`);
        await refresh();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
    });
    ul.appendChild(li);
  }
}

export async function openProjectsDialog(o: ProjectsDialogOptions): Promise<void> {
  opts = o;
  dialog ??= build();
  const d = dialog;
  const form = d.querySelector<HTMLFormElement>('.pd-save')!;
  form.hidden = o.saveName === null;
  d.querySelector<HTMLInputElement>('.pd-name')!.value = o.saveName ? stem(o.saveName) : '';
  setStatus('');
  if (!d.open) d.showModal();
  await refresh();
}

