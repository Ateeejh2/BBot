import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export interface Account { label: string; username: string; auth: 'microsoft' | 'offline' }
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`);
    return value;
  };
  const bool = (key: string, fallback: boolean) => {
    if (env[key] === undefined) return fallback;
    if (!['true', 'false'].includes(env[key]!)) throw new Error(`Invalid ${key}: expected true/false`);
    return env[key] === 'true';
  };
  const mode = env.MODE ?? 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('MODE must be mock or live');
  const level = bool('DEBUG', false) ? 'debug' : (env.LOG_LEVEL ?? 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error('Invalid LOG_LEVEL');
  const count = integer('BOT_COUNT', 1, 1, 20);
  const host = env.SERVER_HOST ?? 'localhost';
  if (!/^[a-z\d.:_-]+$/i.test(host)) throw new Error('Invalid SERVER_HOST');
  const version = env.MC_VERSION || undefined;
  if (version && !/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('Invalid MC_VERSION');
  const reconnectBaseMs = integer('RECONNECT_BASE_MS', 5000, 100, 3_600_000);
  const reconnectMaxMs = integer('RECONNECT_MAX_MS', 120000, reconnectBaseMs, 3_600_000);
  const lobbyCommand = env.LOBBY_COMMAND || undefined;
  if (lobbyCommand && (!/^\/[a-z\d _-]{1,80}$/i.test(lobbyCommand) || /^\/server\b/i.test(lobbyCommand))) throw new Error('Invalid LOBBY_COMMAND');
  const distributionEnabled = bool('DISTRIBUTION_ENABLED', false);
  if (mode === 'live' && distributionEnabled && !lobbyCommand) throw new Error('Distribution requires a verified LOBBY_COMMAND');
  const suspectMs = integer('INSTANCE_SUSPECT_MS', 300000, 1000, 86400000);
  const inactiveMs = integer('INSTANCE_INACTIVE_MS', 1800000, suspectMs + 1, 604800000);
  let accounts: Account[];
  if (mode === 'mock') accounts = Array.from({ length: count }, (_, i) => ({ label: `bot-${i + 1}`, username: `mock-${i + 1}`, auth: 'offline' }));
  else {
    const raw: unknown = JSON.parse(readFileSync(resolve(env.ACCOUNTS_FILE ?? 'accounts.json'), 'utf8'));
    if (!Array.isArray(raw) || raw.length < count || !raw.every(a => a && typeof a.label === 'string' && /^[\w-]{1,40}$/.test(a.label) && typeof a.username === 'string' && a.username.length > 0 && a.username.length <= 256 && ['microsoft', 'offline'].includes(a.auth))) throw new Error('Invalid accounts file');
    accounts = (raw as Account[]).slice(0, count);
    if (new Set(accounts.map(a => a.label)).size !== count || new Set(accounts.map(a => a.username.toLowerCase())).size !== count) throw new Error('Duplicate accounts');
  }
  return {
    mode: mode as 'mock' | 'live', count, host, version, accounts, level: level as 'debug' | 'info' | 'warn' | 'error',
    port: integer('SERVER_PORT', 25565, 1, 65535),
    reconnect: { baseMs: reconnectBaseMs, maxMs: reconnectMaxMs, jitter: integer('RECONNECT_JITTER_PERCENT', 50, 0, 100) / 100 },
    connectTimeoutMs: integer('CONNECT_TIMEOUT_MS', 60000, 1000, 600000),
    connectionSpacingMs: integer('CONNECTION_SPACING_MS', 3000, 100, 60000),
    playCooldownMs: integer('PLAY_COOLDOWN_MS', 15000, 1000, 600000),
    joinTimeoutMs: integer('JOIN_TIMEOUT_MS', 30000, 1000, 600000),
    joinMaxAttempts: integer('JOIN_MAX_ATTEMPTS', 5, 1, 100),
    pathConcurrency: integer('PATH_CONCURRENCY', 2, 1, 20),
    pathTimeoutMs: integer('PATH_TIMEOUT_MS', 30000, 100, 600000),
    taskTimeoutMs: integer('TASK_TIMEOUT_MS', 10000, 100, 600000),
    eventPollMs: integer('EVENT_POLL_MS', 10000, 100, 3600000),
    jobMaxAttempts: integer('JOB_MAX_ATTEMPTS', 3, 1, 100),
    jobRetryMs: integer('JOB_RETRY_MS', 5000, 100, 600000),
    maxJobs: integer('MAX_JOBS', 2000, 20, 100000),
    maxInstances: integer('MAX_INSTANCES', 1000, 20, 100000),
    suspectMs, inactiveMs,
    distributionEnabled, lobbyCommand,
    rerollMaxAttempts: integer('REROLL_MAX_ATTEMPTS', 3, 1, 100),
    rerollCooldownMs: integer('REROLL_COOLDOWN_MS', 60000, 1000, 3600000),
    dataDir: resolve(env.DATA_DIR ?? 'data'), authDir: resolve('.auth'),
    logDir: env.LOG_DIR ? resolve(env.LOG_DIR) : undefined,
    logMaxBytes: integer('LOG_MAX_BYTES', 5_000_000, 1024, 100_000_000),
    logFiles: integer('LOG_FILES', 3, 1, 20)
  };
}
export type Config = ReturnType<typeof loadConfig>;
