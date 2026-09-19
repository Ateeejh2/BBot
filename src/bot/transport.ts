import type { Position } from '../core/types.js';
export interface TransportEvents {
  spawn(): void; worldReset(): void; message(text: string): void; end(): void; error(): void;
  /** Authenticated Minecraft profile name. Public identity only; never a credential. */
  identity?(username: string): void;
  /** Server-provided disconnect/kick reason, normalized by the transport for operator diagnostics. */
  kicked?(reason: string, loggedIn?: boolean): void;
  diagnostic?(name: string, fields?: Record<string, unknown>): void;
  chickenSpawn?(position: Position): void;
  chestAppeared?(position: Position): void;
}
export interface BotTransport {
  position(): Position | undefined;
  /** Server-reported ping for this player. May be unavailable briefly after login. */
  ping?(): number | undefined;
  chat(command: string): void;
  navigate(target: Position, signal: AbortSignal): Promise<void>;
  /** Use a spawn launch pad aligned with the target X/Z and wait until the bot lands. */
  launchToward?(target: Pick<Position, 'x' | 'z'>, signal: AbortSignal): Promise<void>;
  stopPath(): void;
  close(): void;
}
export type TransportFactory = (index: number, events: TransportEvents) => BotTransport;
