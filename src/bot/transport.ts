import type { Position } from '../core/types.js';
export interface TransportEvents {
  spawn(): void; worldReset(): void; message(text: string): void; end(): void; error(): void;
  /** Minecraft server session ended while the Forge client/bridge remains alive. */
  serverDisconnected?(): void;
  /** Authenticated Minecraft profile name. Public identity only; never a credential. */
  identity?(username: string): void;
  /** Server-provided disconnect/kick reason, normalized by the transport for operator diagnostics. */
  kicked?(reason: string, loggedIn?: boolean): void;
  diagnostic?(name: string, fields?: Record<string, unknown>): void;
  chickenSpawn?(position: Position): void;
  chestAppeared?(position: Position): void;
  chestDisappeared?(position: Position): void;
}
export interface BotTransport {
  position(): Position | undefined;
  /** Server-reported ping for this player. May be unavailable briefly after login. */
  ping?(): number | undefined;
  /** Current server tab-list population when the transport can query it reliably. */
  playerCount?(): Promise<number | undefined>;
  /** Bind the transport to the currently confirmed Pit instance for shared terrain caching. */
  setInstance?(instanceId?: string): void;
  chat(command: string): void;
  /** Forge-backed transports can establish and end the Minecraft server session without restarting the client. */
  connectServer?(host: string, port: number): Promise<void>;
  disconnectServer?(): Promise<void>;
  navigate(target: Position, signal: AbortSignal): Promise<void>;
  /** Use a spawn launch pad aligned with the target X/Z. Default waits for landing; event mode can return once launch is confirmed. */
  launchToward?(target: Pick<Position, 'x' | 'z'>, signal: AbortSignal, completion?: 'LAUNCH' | 'LANDING'): Promise<void>;
  stopPath(): void;
  close(): void;
}
export type TransportFactory = (index: number, events: TransportEvents) => BotTransport;
