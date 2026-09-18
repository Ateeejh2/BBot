import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { BotManager } from '../bot/manager.js';

export interface ServerConnection { host: string; port: number; version: '1.8.9'; revision: number }
export interface PublicAccount {
  id: string; label: string; kind: 'MICROSOFT'; status: 'WAITING_FOR_LOGIN' | 'READY' | 'ERROR';
  minecraftName?: string; assignedBot?: string; createdAt: number;
}
interface StoredAccount extends PublicAccount { cacheKey: string; folder: string }
export interface PublicAuthChallenge { verificationUri: string; userCode: string; expiresAt: number }
interface AuthChallengeInput { verificationUri: string; userCode: string; expiresIn: number }
type StartAuth = (
  account: { label: string; cacheKey: string; folder: string },
  config: Config,
  reportChallenge: (challenge: AuthChallengeInput) => void
) => Promise<{ minecraftName?: string } | void>;

export function validateConnection(body: unknown): Pick<ServerConnection, 'host' | 'port' | 'version'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'host,port,version' || b.version !== '1.8.9' ||
      typeof b.host !== 'string' || b.host !== b.host.trim() || b.host.length > 253 ||
      typeof b.port !== 'number' || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) throw Error('INVALID_INPUT');
  const host = b.host;
  // DNS names and IPv4 only. No schemes, paths, brackets, credentials or inline ports.
  if (/^(?:\d+\.){3}\d+$/.test(host)) {
    if (!host.split('.').every(part => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 255)) throw Error('INVALID_INPUT');
  } else {
    const labels = host.endsWith('.') ? host.slice(0, -1).split('.') : host.split('.');
    if (!labels.every(part => part.length > 0 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part)) || /^[\d.]+$/.test(host)) throw Error('INVALID_INPUT');
  }
  return { host, port: b.port, version: '1.8.9' };
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { force: true }); throw error;
  }
}

export class ControlStore {
  private server!: ServerConnection;
  private entries: StoredAccount[] = [];
  private manager?: BotManager;
  private challenges = new Map<string, PublicAuthChallenge>();
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private config: Config, private startAuth: StartAuth) {}
  get busy(): boolean { return this.pending > 0; }
  getServer(): ServerConnection { return { ...this.server }; }
  listAccounts(): PublicAccount[] {
    return this.entries.map(({ id, label, kind, status, minecraftName, assignedBot, createdAt }) => ({ id, label, kind, status, minecraftName, assignedBot, createdAt }));
  }
  getAuthChallenge(id: string): PublicAuthChallenge | undefined {
    const challenge = this.challenges.get(id);
    if (!challenge) return undefined;
    if (challenge.expiresAt <= Date.now()) { this.challenges.delete(id); return undefined; }
    return { ...challenge };
  }
  private reportAuthChallenge(id: string, input: AuthChallengeInput): void {
    try {
      const url = new URL(input.verificationUri);
      const trustedHost = url.hostname === 'microsoft.com' || url.hostname.endsWith('.microsoft.com') ||
        url.hostname === 'live.com' || url.hostname.endsWith('.live.com');
      if (url.protocol !== 'https:' || !trustedHost || url.username || url.password || url.hash ||
          !/^[A-Za-z0-9-]{4,20}$/.test(input.userCode) ||
          !Number.isFinite(input.expiresIn) || input.expiresIn <= 0 || input.expiresIn > 3600) return;
      this.challenges.set(id, {
        verificationUri: url.toString(),
        userCode: input.userCode,
        expiresAt: Date.now() + Math.floor(input.expiresIn * 1000)
      });
    } catch { /* Ignore malformed upstream challenge data. */ }
  }
  async load(): Promise<void> {
    this.server = { host: this.config.host, port: this.config.port, version: '1.8.9', revision: 0 };
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.config.dataDir, 'server-connection.json'), 'utf8'));
      const record = raw as Record<string, unknown>;
      const valid = validateConnection({ host: record?.host, port: record?.port, version: record?.version });
      const revision = (raw as { revision?: unknown }).revision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw Error('INVALID_RUNTIME_CONFIG');
      this.server = { ...valid, revision: revision as number };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('INVALID_RUNTIME_CONFIG'); }
    this.config.host = this.server.host; this.config.port = this.server.port;
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.config.dataDir, 'accounts-runtime.json'), 'utf8'));
      if (!Array.isArray(raw) || raw.length > 20 || !raw.every(a => a &&
        /^[0-9a-f-]{36}$/.test(a.id) && /^[\w-]{1,40}$/.test(a.label) && a.kind === 'MICROSOFT' &&
        ['WAITING_FOR_LOGIN', 'READY', 'ERROR'].includes(a.status) &&
        (a.minecraftName === undefined || (typeof a.minecraftName === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(a.minecraftName))) &&
        typeof a.cacheKey === 'string' && a.cacheKey.length <= 256 && /^[\w-]{1,40}$/.test(a.folder) &&
        Number.isSafeInteger(a.createdAt) && (a.assignedBot === undefined || /^bot-[1-9]\d*$/.test(a.assignedBot)))) throw Error('INVALID_RUNTIME_ACCOUNTS');
      this.entries = raw.map(a => ({ ...a, status: a.status === 'WAITING_FOR_LOGIN' ? 'ERROR' : a.status }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('INVALID_RUNTIME_ACCOUNTS');
      if (this.config.legacyAccountsPresent) this.entries = this.config.accounts.flatMap((a, i) => a.auth === 'microsoft' ? [{
        id: randomUUID(), label: a.label, kind: 'MICROSOFT', status: 'READY',
        assignedBot: `bot-${i+1}`, createdAt: Date.now(), cacheKey: a.username, folder: a.label
      } as StoredAccount] : []);
    }
    const assigned = this.entries.map(a => a.assignedBot).filter(Boolean);
    if (new Set(assigned).size !== assigned.length || assigned.some(id => Number(id!.slice(4)) > this.config.count)) throw Error('INVALID_RUNTIME_ACCOUNTS');
  }
  bind(manager: BotManager): void {
    this.manager = manager;
    for (const a of this.entries) if (a.assignedBot) manager.assignAccount(a.assignedBot, a.id,
      { label: a.label, username: a.cacheKey, auth: 'microsoft' }, a.minecraftName);
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.queue.then(task);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  saveServer(body: unknown): Promise<ServerConnection> {
    const valid = validateConnection(body);
    if (!this.manager?.allDisconnected()) throw Error('INVALID_STATE');
    return this.exclusive(async () => {
      return this.manager!.withConfigurationLock(() => this.manager!.allDisconnected(), async () => {
        const next = { ...valid, revision: this.server.revision + 1 };
        await atomicJson(join(this.config.dataDir, 'server-connection.json'), next);
        this.server = next; this.config.host = next.host; this.config.port = next.port;
        return this.getServer();
      });
    });
  }
  addAccount(body: unknown): Promise<PublicAccount> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
    const b = body as Record<string, unknown>;
    if (b.kind === 'SESSION') throw Error('UNSUPPORTED_AUTH');
    if (Object.keys(b).sort().join(',') !== 'kind,label' || b.kind !== 'MICROSOFT' ||
      typeof b.label !== 'string' || !/^[\w-]{1,40}$/.test(b.label)) throw Error('INVALID_INPUT');
    const label = b.label;
    return this.exclusive(async () => {
      if (this.entries.length >= 20 || this.entries.some(a => a.label.toLowerCase() === label.toLowerCase())) throw Error('CONFLICT');
      const entry: StoredAccount = { id: randomUUID(), label, kind: 'MICROSOFT', status: 'WAITING_FOR_LOGIN',
        createdAt: Date.now(), cacheKey: label, folder: label };
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), [...this.entries, entry]);
      this.entries.push(entry);
      void this.startAuth(entry, this.config, challenge => this.reportAuthChallenge(entry.id, challenge))
        .then(result => this.authResult(entry.id, 'READY', result?.minecraftName), () => this.authResult(entry.id, 'ERROR'));
      return this.listAccounts().find(a => a.id === entry.id)!;
    });
  }
  retryAccount(id: string): Promise<PublicAccount> {
    return this.exclusive(async () => {
      const account = this.entries.find(a => a.id === id);
      if (!account) throw Error('UNKNOWN_ACCOUNT');
      if (account.status !== 'ERROR') throw Error('CONFLICT');
      const updated = this.entries.map(a => a.id === id ? { ...a, status: 'WAITING_FOR_LOGIN' as const } : a);
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
      this.entries = updated;
      this.challenges.delete(id);
      void this.startAuth(account, this.config, challenge => this.reportAuthChallenge(id, challenge))
        .then(result => this.authResult(id, 'READY', result?.minecraftName), () => this.authResult(id, 'ERROR'));
      return this.listAccounts().find(a => a.id === id)!;
    });
  }
  private async authResult(id: string, status: 'READY' | 'ERROR', minecraftName?: string): Promise<void> {
    this.challenges.delete(id);
    try { await this.exclusive(async () => {
      const cleanName = minecraftName && /^[A-Za-z0-9_]{1,16}$/.test(minecraftName) ? minecraftName : undefined;
      const account = this.entries.find(a => a.id === id);
      if (!account) return;
      const autoAssign = status === 'READY' && this.config.count === 1 &&
        !this.entries.some(a => a.assignedBot) &&
        this.manager?.views().find(b => b.id === 'bot-1')?.state === 'DISCONNECTED';
      if (autoAssign) {
        await this.manager!.withConfigurationLock(
          () => this.manager!.views().find(b => b.id === 'bot-1')?.state === 'DISCONNECTED',
          async () => {
            const updated = this.entries.map(a => a.id === id ? {
              ...a, status, ...(cleanName ? { minecraftName: cleanName } : {}), assignedBot: 'bot-1'
            } : a);
            await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
            this.entries = updated;
            this.manager!.assignAccount('bot-1', id,
              { label: account.label, username: account.cacheKey, auth: 'microsoft' }, cleanName);
          }
        );
        return;
      }
      const updated = this.entries.map(a => a.id === id ? { ...a, status, ...(cleanName ? { minecraftName: cleanName } : {}) } : a);
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
      this.entries = updated;
    }); } catch { /* The on-disk WAITING state becomes ERROR after restart. */ }
  }
  assign(botId: string, body: unknown): Promise<PublicAccount | { botId: string; accountId: null }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
    const b = body as Record<string, unknown>;
    if (Object.keys(b).join(',') !== 'accountId' || (typeof b.accountId !== 'string' && b.accountId !== null)) throw Error('INVALID_INPUT');
    const accountId = b.accountId;
    return this.exclusive(async () => {
      const bot = this.manager?.views().find(b => b.id === botId);
      if (!bot) throw Error('UNKNOWN_BOT');
      if (bot.state !== 'DISCONNECTED') throw Error('INVALID_STATE');
      if (accountId === null) {
        return this.manager!.withConfigurationLock(() => this.manager!.views().find(b => b.id === botId)?.state === 'DISCONNECTED', async () => {
          const updated = this.entries.map(a => a.assignedBot === botId ? { ...a, assignedBot: undefined } : a);
          await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
          this.entries = updated;
          this.manager!.unassignAccount(botId);
          return { botId, accountId: null };
        });
      }
      const account = this.entries.find(a => a.id === accountId);
      if (!account) throw Error('UNKNOWN_ACCOUNT');
      if (account.status !== 'READY' || this.entries.some(a => a.id === accountId && a.assignedBot && a.assignedBot !== botId)) throw Error('CONFLICT');
      return this.manager!.withConfigurationLock(() => this.manager!.views().find(b => b.id === botId)?.state === 'DISCONNECTED', async () => {
        const updated = this.entries.map(a => a.id === accountId ? { ...a, assignedBot: botId } :
          a.assignedBot === botId ? { ...a, assignedBot: undefined } : a);
        await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
        this.entries = updated;
        this.manager!.assignAccount(botId, accountId, { label: account.label, username: account.cacheKey, auth: 'microsoft' }, account.minecraftName);
        return this.listAccounts().find(a => a.id === accountId)!;
      });
    });
  }
  deleteAccount(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      const account = this.entries.find(a => a.id === id);
      if (!account) throw Error('UNKNOWN_ACCOUNT');
      const botId = account.assignedBot;
      if (botId) {
        const bot = this.manager?.views().find(b => b.id === botId);
        if (!bot) throw Error('UNKNOWN_BOT');
        if (bot.state !== 'DISCONNECTED') throw Error('INVALID_STATE');
      }
      return this.manager!.withConfigurationLock(
        () => !botId || this.manager!.views().find(b => b.id === botId)?.state === 'DISCONNECTED',
        async () => {
          const updated = this.entries.filter(a => a.id !== id);
          await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
          this.challenges.delete(id);
          this.entries = updated;
          if (botId) this.manager!.unassignAccount(botId);
          return { id };
        }
      );
    });
  }
}
