import type { RGB } from './core/color';
import type { PipelineParams, PipelineResult, WorkerRequest, WorkerResponse } from './protocol';

/**
 * Wraps the processing worker. Only one job runs at a time; while busy, only
 * the most recent request is kept (older pending requests are dropped).
 */
export class WorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private busyId = 0;
  private pending: PipelineParams | null = null;
  private readonly pngRequests = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

  onResult: (r: PipelineResult) => void = () => {};
  onProgress: (stage: string | null) => void = () => {};
  onError: (message: string) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      this.busyId = 0;
      this.onProgress(null);
      this.onError(e.message || 'Worker failed');
    };
  }

  setImage(width: number, height: number, data: Uint8ClampedArray): void {
    const msg: WorkerRequest = { type: 'image', width, height, data };
    this.worker.postMessage(msg, [data.buffer]);
  }

  process(params: PipelineParams): void {
    if (this.busyId) {
      this.pending = params;
      return;
    }
    this.send(params);
  }

  /** Render the flattened PNG at the given size (off the main thread when possible). */
  renderPng(width: number, height: number, colors: (RGB | null)[]): Promise<Blob> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pngRequests.set(id, { resolve, reject });
      const msg: WorkerRequest = { type: 'png', id, width, height, colors };
      this.worker.postMessage(msg);
    });
  }

  private send(params: PipelineParams): void {
    const id = this.nextId++;
    this.busyId = id;
    this.onProgress('Working…');
    const msg: WorkerRequest = { type: 'process', id, params };
    this.worker.postMessage(msg);
  }

  private handle(msg: WorkerResponse): void {
    const png = this.pngRequests.get(msg.id);
    if (png) {
      this.pngRequests.delete(msg.id);
      if (msg.type === 'png') {
        if (msg.blob) png.resolve(msg.blob);
        else encodePngOnMainThread(msg.rgba!, msg.width, msg.height).then(png.resolve, png.reject);
      } else if (msg.type === 'error') png.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'progress') {
      if (!this.pending) this.onProgress(msg.stage);
      return;
    }
    this.busyId = 0;
    const next = this.pending;
    this.pending = null;
    if (next) {
      this.send(next);
      return;
    }
    this.onProgress(null);
    if (msg.type === 'result') this.onResult(msg.result);
    else if (msg.type === 'error') this.onError(msg.message);
  }
}

function encodePngOnMainThread(rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}
