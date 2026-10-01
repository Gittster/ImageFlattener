import { strToU8, zipSync } from 'fflate';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function svgBlob(svg: string): Blob {
  return new Blob([svg], { type: 'image/svg+xml' });
}

export function zipBlob(files: { name: string; content: string }[]): Blob {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = strToU8(f.content);
  const data = zipSync(entries, { level: 6 });
  return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

/** File-name-safe stem of an image name. */
export function baseName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return stem || 'image';
}
