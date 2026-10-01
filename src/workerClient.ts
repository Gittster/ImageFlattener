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

  private send(params: PipelineParams): void {
    const id = this.nextId++;
    this.busyId = id;
    this.onProgress('Working…');
    const msg: WorkerRequest = { type: 'process', id, params };
    this.worker.postMessage(msg);
  }

  private handle(msg: WorkerResponse): void {
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
    else this.onError(msg.message);
  }
}
