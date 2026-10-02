import { EDIT_NONE, paintSegment, undoStroke, type StrokeUndo } from './core/edits';

export type Tool = 'pan' | 'brush' | 'eraser';

export interface PaintHooks {
  /** Width/height of the working image, or null when nothing is loaded. */
  size(): { width: number; height: number } | null;
  /** RGBA (0-255) shown for a pixel whose edit value is `v` (EDIT_NONE = computed label). */
  pixelColor(index: number, v: number): [number, number, number, number];
  /** Called after a stroke, undo or clear changed the edit layer. */
  onChange(): void;
  /** Called before the first stroke (e.g. to switch to the raster view). */
  onBeforePaint(): void;
}

/**
 * Brush tool on the preview: paints palette-entry ids into an edit layer
 * (see core/edits.ts), with immediate feedback on the raster canvas and undo.
 */
export class PaintController {
  tool: Tool = 'pan';
  /** Edit value painted by the brush (entry id + 1, or EDIT_VOID). */
  value = EDIT_NONE;
  /** Brush diameter in working-image pixels. */
  diameter = 8;
  edits: Uint8Array | null = null;
  /** Incremented on every change; sent to the worker. */
  version = 0;
  private undoStack: StrokeUndo[] = [];
  private stroke: { undo: StrokeUndo; touched: Set<number>; x: number; y: number; id: number } | null = null;
  private spaceDown = false;
  private readonly cursor: HTMLDivElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly content: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly scale: () => number,
    private readonly hooks: PaintHooks,
  ) {
    this.cursor = document.createElement('div');
    this.cursor.className = 'brush-cursor';
    this.cursor.hidden = true;
    container.appendChild(this.cursor);
    container.addEventListener('pointerdown', (e) => this.down(e));
    container.addEventListener('pointermove', (e) => this.move(e));
    container.addEventListener('pointerup', (e) => this.up(e));
    container.addEventListener('pointercancel', (e) => this.up(e));
    container.addEventListener('pointerleave', () => (this.cursor.hidden = true));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) this.spaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  /** Whether a left-button drag should pan rather than paint. */
  wantsPan(): boolean {
    return this.tool === 'pan' || this.spaceDown || !this.hooks.size();
  }

  /** Start a fresh edit layer (new image). */
  reset(): void {
    this.edits = null;
    this.undoStack = [];
    this.version++;
  }

  /** Replace the edit layer (project load, remapping). */
  setEdits(edits: Uint8Array | null): void {
    this.edits = edits;
    this.undoStack = [];
    this.version++;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  undo(): void {
    const u = this.undoStack.pop();
    if (!u || !this.edits) return;
    undoStroke(this.edits, u);
    this.version++;
    this.repaint(u.indices);
    this.hooks.onChange();
  }

  clear(): void {
    if (!this.edits) return;
    const indices: number[] = [];
    const previous: number[] = [];
    for (let i = 0; i < this.edits.length; i++) {
      if (this.edits[i] !== EDIT_NONE) {
        indices.push(i);
        previous.push(this.edits[i]);
        this.edits[i] = EDIT_NONE;
      }
    }
    if (!indices.length) return;
    this.undoStack.push({ indices, previous });
    this.version++;
    this.repaint(indices);
    this.hooks.onChange();
  }

  private imagePoint(e: PointerEvent): { x: number; y: number } | null {
    const size = this.hooks.size();
    if (!size) return null;
    const rect = this.content.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * size.width, y: ((e.clientY - rect.top) / rect.height) * size.height };
  }

  private updateCursor(e: PointerEvent): void {
    const show = this.tool !== 'pan' && !this.spaceDown && !!this.hooks.size();
    this.cursor.hidden = !show;
    this.container.classList.toggle('painting', show);
    if (!show) return;
    const d = Math.max(4, this.diameter * this.scale());
    const r = this.container.getBoundingClientRect();
    Object.assign(this.cursor.style, {
      width: `${d}px`,
      height: `${d}px`,
      left: `${e.clientX - r.left - d / 2}px`,
      top: `${e.clientY - r.top - d / 2}px`,
    });
    this.cursor.classList.toggle('eraser', this.tool === 'eraser');
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.wantsPan()) return;
    const p = this.imagePoint(e);
    const size = this.hooks.size();
    if (!p || !size) return;
    this.hooks.onBeforePaint();
    if (!this.edits || this.edits.length !== size.width * size.height) this.edits = new Uint8Array(size.width * size.height);
    this.container.setPointerCapture(e.pointerId);
    this.stroke = { undo: { indices: [], previous: [] }, touched: new Set(), x: p.x, y: p.y, id: e.pointerId };
    this.paintTo(p.x, p.y);
    e.preventDefault();
  }

  private move(e: PointerEvent): void {
    this.updateCursor(e);
    if (!this.stroke || e.pointerId !== this.stroke.id) return;
    const p = this.imagePoint(e);
    if (p) this.paintTo(p.x, p.y);
  }

  private up(e: PointerEvent): void {
    if (!this.stroke || e.pointerId !== this.stroke.id) return;
    const s = this.stroke;
    this.stroke = null;
    if (s.undo.indices.length) {
      this.undoStack.push(s.undo);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.version++;
      this.hooks.onChange();
    }
  }

  private paintTo(x: number, y: number): void {
    const s = this.stroke;
    const size = this.hooks.size();
    if (!s || !size || !this.edits) return;
    const value = this.tool === 'eraser' ? EDIT_NONE : this.value;
    const changed: number[] = [];
    paintSegment(this.edits, size.width, size.height, s.x, s.y, x, y, this.diameter, value, s.undo, s.touched, (i) => changed.push(i));
    s.x = x;
    s.y = y;
    this.repaint(changed);
  }

  /** Redraw the given pixels on the raster canvas. */
  repaint(indices: number[]): void {
    const size = this.hooks.size();
    if (!size || !indices.length || this.canvas.width !== size.width) return;
    const g = this.canvas.getContext('2d', { willReadFrequently: true })!;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const i of indices) {
      const x = i % size.width, y = (i / size.width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const img = g.getImageData(x0, y0, w, h);
    for (const i of indices) {
      const x = i % size.width, y = (i / size.width) | 0;
      const o = ((y - y0) * w + (x - x0)) * 4;
      const c = this.hooks.pixelColor(i, this.edits ? this.edits[i] : EDIT_NONE);
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = c[3];
    }
    g.putImageData(img, x0, y0);
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
