import type { Position } from '../core/types.js';
import { abortableDelay } from '../recovery/backoff.js';
import type { BotTransport, TransportEvents } from './transport.js';
export class MockTransport implements BotTransport {
  private current: Position = { x: 0, y: 64, z: 0 };
  private closed = false;
  private lifetime = new AbortController();
  constructor(readonly events: TransportEvents, private instance: () => string = () => 'mock-pit-1') {
    queueMicrotask(() => { if (!this.closed) events.spawn(); });
  }
  position(): Position { return { ...this.current }; }
  chat(command: string): void {
    if (this.closed) throw new Error('Closed');
    if (command === '/play pit') {
      this.events.message(`SERVER FOUND! Sending to ${this.instance()}!`);
      this.events.worldReset(); this.events.spawn();
    } else { this.events.worldReset(); this.events.spawn(); }
  }
  async navigate(target: Position, signal: AbortSignal): Promise<void> {
    await abortableDelay(20, AbortSignal.any([signal, this.lifetime.signal]));
    this.current = { ...target };
  }
  async launchToward(target: Pick<Position, 'x' | 'z'>, signal: AbortSignal): Promise<void> {
    await abortableDelay(20, AbortSignal.any([signal, this.lifetime.signal]));
    this.current = { x: target.x, y: 64, z: target.z };
  }
  stopPath(): void {}
  close(): void { this.closed = true; this.lifetime.abort(); }
}
