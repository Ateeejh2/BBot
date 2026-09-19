import type { BotState } from './types.js';
const allowed: Record<BotState, readonly BotState[]> = {
  DISCONNECTED: ['CONNECTING'], CONNECTING: ['LOBBY', 'DISCONNECTED', 'RECOVERING'],
  LOBBY: ['JOINING_PIT', 'PATHFINDING', 'RECOVERING', 'DISCONNECTED'],
  JOINING_PIT: ['IN_PIT_IDLE', 'RECOVERING', 'DISCONNECTED'],
  IN_PIT_IDLE: ['PREPARING_EVENT', 'PATHFINDING', 'RECOVERING', 'DISCONNECTED'],
  PREPARING_EVENT: ['IN_PIT_IDLE', 'RECOVERING', 'DISCONNECTED'],
  PATHFINDING: ['WORKING', 'IN_PIT_IDLE', 'LOBBY', 'RECOVERING', 'DISCONNECTED'],
  WORKING: ['IN_PIT_IDLE', 'RECOVERING', 'DISCONNECTED'],
  RECOVERING: ['LOBBY', 'JOINING_PIT', 'DISCONNECTED']
};
export class StateMachine {
  private current: BotState = 'DISCONNECTED';
  constructor(private readonly changed: (from: BotState, to: BotState) => void = () => {}) {}
  get state(): BotState { return this.current; }
  transition(next: BotState): void {
    if (next === this.current) return;
    if (!allowed[this.current].includes(next)) throw new Error(`Invalid transition ${this.current} -> ${next}`);
    const previous = this.current; this.current = next; this.changed(previous, next);
  }
}
export class Generation {
  private value = 0;
  get current(): number { return this.value; }
  invalidate(): number { return ++this.value; }
  isCurrent(token: number): boolean { return token === this.value; }
}
