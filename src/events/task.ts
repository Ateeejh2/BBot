import type { BotView, GameEvent } from '../core/types.js';
export interface TaskHandler {
  /** Must honor abort and use event.id as idempotency key for external effects. */
  onArrive(bot: BotView, event: GameEvent, signal: AbortSignal): Promise<void>;
}
export class MockTaskHandler implements TaskHandler {
  async onArrive(_bot: BotView, _event: GameEvent, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); }
}
