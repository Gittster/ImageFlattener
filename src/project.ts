import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { RGB } from './core/color';
import type { Filament } from './core/filaments';

/**
 * Project files (.ifproj) are ZIP archives:
 *   project.json   settings, palette edits, stack order (see ProjectDoc)
 *   image.<ext>    the original image file, byte for byte
 *   edits.bin      brush edit layer (one byte per working pixel), optional
 */
export const PROJECT_FORMAT = 'image-flattener-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.ifproj';

export interface SavedEntry {
  id: number;
  clusters: number[];
  base: RGB;
  override: string | null;
  filament: Filament | null;
}

export interface ProjectDoc {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  image: { name: string; file: string; type: string; workingWidth: number; workingHeight: number };
  /** All user settings (see main.ts SETTINGS_KEYS). */
  settings: Record<string, unknown>;
  palette: { clusterCount: number; entries: SavedEntry[]; stackIds: number[] } | null;
  edits: { file: string; width: number; height: number } | null;
}

export interface LoadedProject {
  doc: ProjectDoc;
  image: Blob;
  edits: Uint8Array | null;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export async function buildProject(
  doc: Omit<ProjectDoc, 'format' | 'version' | 'savedAt' | 'image' | 'edits'> & { image: { name: string; workingWidth: number; workingHeight: number } },
  image: Blob,
  edits: { data: Uint8Array; width: number; height: number } | null,
): Promise<Blob> {
  const ext = EXT_BY_TYPE[image.type] ?? (doc.image.name.split('.').pop() || 'img').toLowerCase();
  const imageFile = `image.${ext}`;
  const full: ProjectDoc = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    image: { ...doc.image, file: imageFile, type: image.type },
    settings: doc.settings,
    palette: doc.palette,
    edits: edits ? { file: 'edits.bin', width: edits.width, height: edits.height } : null,
  };
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    'project.json': strToU8(JSON.stringify(full, null, 2)),
    // Images are already compressed; store them as-is.
    [imageFile]: [new Uint8Array(await image.arrayBuffer()), { level: 0 }],
  };
  if (edits) files['edits.bin'] = edits.data;
  const zip = zipSync(files, { level: 6 });
  return new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

export async function readProject(file: Blob): Promise<LoadedProject> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('This file is not an Image Flattener project.');
  }
  const json = entries['project.json'];
  if (!json) throw new Error('This file is not an Image Flattener project (project.json missing).');
  const doc = JSON.parse(strFromU8(json)) as ProjectDoc;
  if (doc.format !== PROJECT_FORMAT) throw new Error('This file is not an Image Flattener project.');
  if (doc.version > PROJECT_VERSION) throw new Error('This project was saved by a newer version of Image Flattener.');
  const img = entries[doc.image?.file];
  if (!img) throw new Error('The project file is missing its image.');
  const editsData = doc.edits ? entries[doc.edits.file] : undefined;
  return {
    doc,
    image: new Blob([img as Uint8Array<ArrayBuffer>], { type: doc.image.type || 'application/octet-stream' }),
    edits: editsData && doc.edits && editsData.length === doc.edits.width * doc.edits.height ? editsData : null,
  };
}

export function isProjectFile(f: File): boolean {
  return f.name.toLowerCase().endsWith(PROJECT_EXTENSION);
}
