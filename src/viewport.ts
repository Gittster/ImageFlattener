/**
 * Zoom/pan state shared by several panes. Wheel zooms around the cursor,
 * dragging pans, double-click fits the content.
 */
export class ViewportGroup {
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private contentW = 1;
  private contentH = 1;
  private readonly panes: { container: HTMLElement; content: HTMLElement }[] = [];

  add(container: HTMLElement, content: HTMLElement): void {
    this.panes.push({ container, content });
    container.addEventListener('wheel', (e) => this.onWheel(e, container), { passive: false });
    container.addEventListener('dblclick', () => this.fit());
    let drag: { id: number; x: number; y: number } | null = null;
    container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      container.setPointerCapture(e.pointerId);
      container.classList.add('dragging');
    });
    container.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      this.tx += e.clientX - drag.x;
      this.ty += e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.apply();
    });
    const end = (e: PointerEvent): void => {
      if (drag && drag.id === e.pointerId) {
        drag = null;
        container.classList.remove('dragging');
      }
    };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
    this.apply();
  }

  setContentSize(w: number, h: number): void {
    const changed = w !== this.contentW || h !== this.contentH;
    this.contentW = Math.max(1, w);
    this.contentH = Math.max(1, h);
    for (const p of this.panes) {
      p.content.style.width = `${this.contentW}px`;
      p.content.style.height = `${this.contentH}px`;
    }
    if (changed) this.fit();
  }

  fit(): void {
    const c = this.panes[0]?.container;
    if (!c) return;
    const cw = c.clientWidth || 400;
    const ch = c.clientHeight || 300;
    this.scale = Math.min(cw / this.contentW, ch / this.contentH) * 0.95;
    if (!isFinite(this.scale) || this.scale <= 0) this.scale = 1;
    this.tx = (cw - this.contentW * this.scale) / 2;
    this.ty = (ch - this.contentH * this.scale) / 2;
    this.apply();
  }

  zoomBy(factor: number): void {
    const c = this.panes[0]?.container;
    if (!c) return;
    this.zoomAt(factor, c.clientWidth / 2, c.clientHeight / 2);
  }

  private onWheel(e: WheelEvent, container: HTMLElement): void {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    this.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const next = Math.min(64, Math.max(0.02, this.scale * factor));
    const f = next / this.scale;
    this.tx = cx - (cx - this.tx) * f;
    this.ty = cy - (cy - this.ty) * f;
    this.scale = next;
    this.apply();
  }

  private apply(): void {
    for (const p of this.panes) {
      p.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
      p.container.classList.toggle('pixelated', this.scale >= 2);
    }
  }
}
