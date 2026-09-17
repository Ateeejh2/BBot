export interface Position { x: number; y: number; z: number }
export interface GameEvent {
  id: string; instanceId: string; target: Position; type: string;
  expiresAt: number; metadata?: Record<string, unknown>;
}
export type BotState = 'DISCONNECTED' | 'CONNECTING' | 'LOBBY' | 'JOINING_PIT' |
  'IN_PIT_IDLE' | 'PATHFINDING' | 'WORKING' | 'RECOVERING';
export type JobState = 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export interface Job {
  id: string; event: GameEvent; state: JobState; attempts: number; lease: number;
  botId?: string; updatedAt: number; availableAt: number;
}
export interface BotView {
  id: string; accountLabel: string; state: BotState; instanceId?: string;
  generation: number; position?: Position;
}
export type ReturnReason = 'UNKNOWN_RETURN' | 'AFK' | 'PLANNED';
export interface ReturnClassifier { classify(message: string): ReturnReason | undefined }
// No speculative AFK messages, titles or server-specific lobby assumptions.
export class UnknownReturnClassifier implements ReturnClassifier {
  classify(_message: string): undefined { return undefined; }
}
export function instanceKey(id: string): string { return id.toLowerCase(); }
export function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function validEvent(value: unknown): value is GameEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as GameEvent;
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 128 &&
    typeof e.instanceId === 'string' && /^[\w.-]{1,128}$/.test(e.instanceId) &&
    typeof e.type === 'string' && e.type.length > 0 && e.type.length <= 128 &&
    Number.isSafeInteger(e.expiresAt) && !!e.target &&
    [e.target.x, e.target.y, e.target.z].every(n => Number.isFinite(n) && Math.abs(n) <= 30_000_000) &&
    (e.metadata === undefined || (!!e.metadata && typeof e.metadata === 'object' &&
      !Array.isArray(e.metadata) && JSON.stringify(e.metadata).length <= 4096));
}
