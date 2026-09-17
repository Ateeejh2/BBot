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
    if (signal.aborted || this.keys.has(key) || this.queue.length >= this.maxQueue) return Promise.reject(new Error('Path rejected'));
    this.keys.add(key);
    return new Promise<void>((resolve, reject) => {
      const entry: Entry = { key, signal, run, stop, resolve, reject, queuedAbort: () => {
        this.queue = this.queue.filter(e => e !== entry); this.keys.delete(key);
        signal.removeEventListener('abort', entry.queuedAbort); reject(new Error('Path cancelled in queue'));
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
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let settled = false;
      finish = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); entry.signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
        // stop MUST synchronously disable further movement/replanning before releasing the slot.
        try { entry.stop(); } catch { error = new Error('Path stop failed'); }
        this.running.delete(entry.key); this.keys.delete(entry.key);
        if (error) entry.reject(error); else entry.resolve();
        this.drain();
      };
      const cancelled = () => finish(new Error('Path cancelled or timed out'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (entry.signal.aborted) { controller.abort(); continue; }
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted(); return entry.run(controller.signal);
      }).then(() => finish(), () => finish(new Error('Path failed')));
    }
  }
}
