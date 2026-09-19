export type PathFailureCode = 'PATH_NOT_FOUND' | 'PATH_TIMEOUT' | 'PATH_CANCELLED' | 'PATH_REJECTED' | 'PATH_FAILED';

export class PathfindingError extends Error {
  constructor(readonly code: PathFailureCode, options?: { cause?: unknown }) {
    super(code, options); this.name = 'PathfindingError';
  }
}
function runFailure(error: unknown): PathfindingError {
  if (error instanceof PathfindingError) return error;
  if (error instanceof Error && (error.name === 'NoPath' || /no path to the goal/i.test(error.message))) return new PathfindingError('PATH_NOT_FOUND', { cause: error });
  return new PathfindingError('PATH_FAILED', { cause: error });
}
interface Entry {
  key: string; signal: AbortSignal; run: (signal: AbortSignal) => Promise<void>;
  stop: () => void; resolve: () => void; reject: (error: Error) => void;
  queuedAbort: () => void;
}
/** A slot covers the whole movement, including pathfinder's automatic replans. */
export class PathfindingController {
  private queue: Entry[] = [];
  private running = new Map<string, AbortController>();
  private keys = new Set<string>();
  constructor(readonly concurrency: number, private timeoutMs: number, private maxQueue = 100) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || timeoutMs < 1) throw new Error('Invalid path controller options');
  }
  get active(): number { return this.running.size; }
  get queued(): number { return this.queue.length; }
  submit(key: string, signal: AbortSignal, run: Entry['run'], stop: () => void): Promise<void> {
    if (signal.aborted || this.keys.has(key) || this.queue.length >= this.maxQueue) return Promise.reject(new PathfindingError('PATH_REJECTED'));
    this.keys.add(key);
    return new Promise<void>((resolve, reject) => {
      const entry: Entry = { key, signal, run, stop, resolve, reject, queuedAbort: () => {
        this.queue = this.queue.filter(e => e !== entry); this.keys.delete(key);
        signal.removeEventListener('abort', entry.queuedAbort); reject(new PathfindingError('PATH_CANCELLED'));
      } };
      signal.addEventListener('abort', entry.queuedAbort, { once: true });
      this.queue.push(entry); this.drain();
    });
  }
  cancelAll(): void {
    for (const entry of [...this.queue]) entry.queuedAbort();
    for (const controller of this.running.values()) controller.abort();
  }
  private drain(): void {
    while (this.running.size < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!;
      entry.signal.removeEventListener('abort', entry.queuedAbort);
      const controller = new AbortController(); this.running.set(entry.key, controller);
      const abort = () => controller.abort();
      entry.signal.addEventListener('abort', abort, { once: true });
      let finish!: (error?: Error) => void;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      let settled = false;
      finish = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); entry.signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
        // stop MUST synchronously disable further movement/replanning before releasing the slot.
        try { entry.stop(); } catch (stopError) { error = new PathfindingError('PATH_FAILED', { cause: stopError }); }
        this.running.delete(entry.key); this.keys.delete(entry.key);
        if (error) entry.reject(error); else entry.resolve();
        this.drain();
      };
      const cancelled = () => finish(new PathfindingError(timedOut ? 'PATH_TIMEOUT' : 'PATH_CANCELLED'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (entry.signal.aborted) { controller.abort(); continue; }
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return entry.run(controller.signal);
      }).then(() => finish(), error => finish(runFailure(error)));
    }
  }
}
