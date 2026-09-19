export interface BackoffOptions { baseMs: number; maxMs: number; jitter: number }
export function backoff(attempt: number, options: BackoffOptions, random = Math.random): number {
  const cap = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(Math.max(attempt, 0), 30));
  return Math.round(cap * (1 - options.jitter + Math.max(0, Math.min(1, random())) * options.jitter));
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('Aborted')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
