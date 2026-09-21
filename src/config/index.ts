import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export type Account =
  | { label: string; username: string; auth: 'microsoft' | 'offline'; kind?: 'MICROSOFT' }
  | { label: string; username: string; auth: 'mojang'; kind: 'SESSION'; accountId: string };
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
  const transport = env.BBOT_TRANSPORT ?? 'mineflayer';
  if (!['mineflayer', 'forge'].includes(transport)) throw new Error('BBOT_TRANSPORT must be mineflayer or forge');
  const level = bool('DEBUG', false) ? 'debug' : (env.LOG_LEVEL ?? 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error('Invalid LOG_LEVEL');
  const count = integer('BOT_COUNT', 1, 1, 20);
  const forgeBridgeBasePort = integer('FORGE_BRIDGE_BASE_PORT', 3010, 1024, 65535);
  if (forgeBridgeBasePort + count - 1 > 65535) throw new Error('FORGE_BRIDGE_BASE_PORT range exceeds 65535');
  const forgePocDir = resolve(env.FORGE_POC_DIR ?? 'poc/headless-forge-1.8.9');
  const forgeJava8Home = env.FORGE_JAVA8_HOME?.trim() || env.JAVA8_HOME?.trim() || undefined;
  const host = env.SERVER_HOST ?? 'localhost';
  if (!/^[a-z\d.:_-]+$/i.test(host)) throw new Error('Invalid SERVER_HOST');
  const version = env.MC_VERSION?.trim() || '1.8.9';
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('Invalid MC_VERSION');
  const reconnectBaseMs = integer('RECONNECT_BASE_MS', 5000, 100, 3_600_000);
  const reconnectMaxMs = integer('RECONNECT_MAX_MS', 120000, reconnectBaseMs, 3_600_000);
  const lobbyCommand = env.LOBBY_COMMAND || undefined;
  if (lobbyCommand && (!/^\/[a-z\d _-]{1,80}$/i.test(lobbyCommand) || /^\/server\b/i.test(lobbyCommand))) throw new Error('Invalid LOBBY_COMMAND');
  const transferMessageChannel = env.TRANSFER_MESSAGE_CHANNEL ?? 'system';
  if (!['system', 'chat'].includes(transferMessageChannel)) throw new Error('Invalid TRANSFER_MESSAGE_CHANNEL');
  const eventProviderUrl = env.EVENT_PROVIDER_URL?.trim() || undefined;
  if (eventProviderUrl) {
    let url: URL;
    try { url = new URL(eventProviderUrl); } catch { throw new Error('Invalid EVENT_PROVIDER_URL'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash) throw new Error('Invalid EVENT_PROVIDER_URL');
  }
  const distributionEnabled = bool('DISTRIBUTION_ENABLED', false);
  if (mode === 'live' && distributionEnabled && !lobbyCommand) throw new Error('Distribution requires a verified LOBBY_COMMAND');
  const suspectMs = integer('INSTANCE_SUSPECT_MS', 300000, 1000, 86400000);
  const inactiveMs = integer('INSTANCE_INACTIVE_MS', 1800000, suspectMs + 1, 604800000);
  const viewerEnabled = bool('VIEWER_ENABLED', false);
  const apiEnabled = bool('API_ENABLED', false);
  const apiHost = env.API_HOST ?? '127.0.0.1';
  if (apiHost !== '127.0.0.1') throw new Error('API_HOST must be 127.0.0.1; use a protected reverse proxy');
  const apiOrigin = env.API_ORIGIN;
  if (apiEnabled && (!apiOrigin || !/^https?:\/\/[^/]+$/.test(apiOrigin) || new URL(apiOrigin).username || new URL(apiOrigin).password)) throw new Error('API_ORIGIN must be a single web origin');
  const viewerUrl = env.VIEWER_PUBLIC_URL;
  if (viewerUrl && (!/^https?:\/\/[^/]+\/?$/.test(viewerUrl) || new URL(viewerUrl).username || new URL(viewerUrl).password || new URL(viewerUrl).search || new URL(viewerUrl).hash)) throw new Error('Invalid VIEWER_PUBLIC_URL');
  const viewerBotId = env.VIEWER_BOT_ID ?? 'bot-1';
  if (!/^bot-(?:[1-9]|1\d|20)$/.test(viewerBotId)) throw new Error('Invalid VIEWER_BOT_ID');
  const viewerBotNumber = Number(viewerBotId.slice(4));
  if (viewerEnabled && viewerBotNumber > count) throw new Error('VIEWER_BOT_ID exceeds BOT_COUNT');
  let accounts: Account[];
  let legacyAccountsPresent = false;
  if (mode === 'mock') accounts = Array.from({ length: count }, (_, i) => ({ label: `bot-${i + 1}`, username: `mock-${i + 1}`, auth: 'offline' }));
  else if (transport === 'forge' && !apiEnabled) {
    accounts = Array.from({ length: count }, (_, i) => ({
      label: `bot-${i + 1}`,
      username: `forge-bot-${i + 1}`,
      auth: 'offline' as const
    }));
  } else {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(resolve(env.ACCOUNTS_FILE ?? 'accounts.json'), 'utf8')); legacyAccountsPresent = true; }
    catch (error) {
      if (!apiEnabled || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = [];
    }
    if (!Array.isArray(raw) || (!apiEnabled && raw.length < count) ||
        !raw.every(a => a && typeof a.label === 'string' && /^[\w-]{1,40}$/.test(a.label) &&
          typeof a.username === 'string' && a.username.length > 0 && a.username.length <= 256 &&
          ['microsoft', 'offline'].includes(a.auth))) throw new Error('Invalid accounts file');
    const configured = (raw as Account[]).slice(0, count);
    if (new Set(configured.map(a => a.label)).size !== configured.length ||
        new Set(configured.map(a => a.username.toLowerCase())).size !== configured.length) throw new Error('Duplicate accounts');
    accounts = apiEnabled
      ? [...configured, ...Array.from({ length: Math.max(0, count - configured.length) }, (_, i) => {
          const n = configured.length + i + 1;
          return { label: `unassigned-${n}`, username: `unassigned-${n}`, auth: 'offline' as const };
        })]
      : configured;
  }
  return {
    mode: mode as 'mock' | 'live', transport: transport as 'mineflayer' | 'forge',
    count, host, version, accounts, legacyAccountsPresent, level: level as 'debug' | 'info' | 'warn' | 'error',
    forge: { bridgeBasePort: forgeBridgeBasePort, pocDir: forgePocDir, java8Home: forgeJava8Home },
    port: integer('SERVER_PORT', 25565, 1, 65535),
    reconnect: { baseMs: reconnectBaseMs, maxMs: reconnectMaxMs, jitter: integer('RECONNECT_JITTER_PERCENT', 50, 0, 100) / 100 },
    connectTimeoutMs: integer('CONNECT_TIMEOUT_MS', 60000, 1000, 600000),
    connectionSpacingMs: integer('CONNECTION_SPACING_MS', 3000, 100, 60000),
    playCooldownMs: integer('PLAY_COOLDOWN_MS', 15000, 1000, 600000),
    joinTimeoutMs: integer('JOIN_TIMEOUT_MS', 30000, 1000, 600000),
    joinMaxAttempts: integer('JOIN_MAX_ATTEMPTS', 5, 1, 100),
    pitEventMinPlayers: integer('PIT_EVENT_MIN_PLAYERS', 21, 0, 200),
    pitPopulationCheckMs: integer('PIT_POPULATION_CHECK_MS', 10000, 1000, 600000),
    pathConcurrency: integer('PATH_CONCURRENCY', 2, 1, 20),
    pathTimeoutMs: integer('PATH_TIMEOUT_MS', 30000, 100, 600000),
    taskTimeoutMs: integer('TASK_TIMEOUT_MS', 10000, 100, 600000),
    eventPollMs: integer('EVENT_POLL_MS', 10000, 100, 3600000),
    eventProviderUrl,
    jobMaxAttempts: integer('JOB_MAX_ATTEMPTS', 3, 1, 100),
    jobRetryMs: integer('JOB_RETRY_MS', 5000, 100, 600000),
    maxJobs: integer('MAX_JOBS', 2000, 20, 100000),
    maxInstances: integer('MAX_INSTANCES', 1000, 20, 100000),
    suspectMs, inactiveMs,
    distributionEnabled, lobbyCommand, transferMessageChannel: transferMessageChannel as 'system' | 'chat',
    rerollMaxAttempts: integer('REROLL_MAX_ATTEMPTS', 3, 1, 100),
    rerollCooldownMs: integer('REROLL_COOLDOWN_MS', 60000, 1000, 3600000),
    api: { enabled: apiEnabled, host: apiHost, port: integer('API_PORT', 3008, 1024, 65535), origin: apiOrigin },
    viewer: {
      enabled: viewerEnabled,
      publicUrl: viewerUrl,
      botId: viewerBotId,
      port: integer('VIEWER_PORT', 3007, 1024, 65535),
      viewDistance: integer('VIEWER_VIEW_DISTANCE', 4, 2, 12),
      firstPerson: bool('VIEWER_FIRST_PERSON', true)
    },
    dataDir: resolve(env.DATA_DIR ?? 'data'), authDir: resolve('.auth'),
    logDir: env.LOG_DIR ? resolve(env.LOG_DIR) : undefined,
    logMaxBytes: integer('LOG_MAX_BYTES', 5_000_000, 1024, 100_000_000),
    logFiles: integer('LOG_FILES', 3, 1, 20)
  };
}
export type Config = ReturnType<typeof loadConfig>;
