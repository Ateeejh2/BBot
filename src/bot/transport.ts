import type { Position } from '../core/types.js';
export interface TransportEvents {
  spawn(): void; worldReset(): void; message(text: string): void; end(): void; error(): void;
}
export interface BotTransport {
  position(): Position | undefined;
  chat(command: string): void;
  navigate(target: Position, signal: AbortSignal): Promise<void>;
  stopPath(): void;
  close(): void;
}
export type TransportFactory = (index: number, events: TransportEvents) => BotTransport;
