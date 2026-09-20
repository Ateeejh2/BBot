export interface Position { x: number; y: number; z: number }
export interface GameEvent {
  id: string; instanceId: string; target: Position; type: string;
  expiresAt: number; metadata?: Record<string, unknown>;
}
export type BotState = 'DISCONNECTED' | 'CONNECTING' | 'LOBBY' | 'JOINING_PIT' |
  'IN_PIT_IDLE' | 'PREPARING_EVENT' | 'PATHFINDING' | 'WORKING' | 'RECOVERING';
export type JobState = 'QUEUED' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
export type JobFailureReason =
  | 'PATH_NOT_FOUND' | 'PATH_TIMEOUT' | 'PATH_CANCELLED' | 'PATH_REJECTED' | 'PATH_FAILED'
  | 'INSTANCE_LOST' | 'JOB_EXPIRED' | 'TASK_TIMEOUT' | 'TASK_FAILED';
export interface Job {
  id: string; event: GameEvent; state: JobState; attempts: number; lease: number;
  botId?: string; updatedAt: number; availableAt: number;
  lastFailure?: JobFailureReason; lastFailureAt?: number; retryAt?: number;
}
export interface BotView {
  id: string; accountLabel: string; accountId?: string; minecraftName?: string; state: BotState; instanceId?: string;
  generation: number; position?: Position; startQueued?: boolean; jobId?: string; kickReason?: string; kickedAt?: number;
}
export type ReturnReason = 'UNKNOWN_RETURN' | 'AFK' | 'PLANNED' | 'LIMBO';
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
