import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { BotManager } from '../bot/manager.js';
import type { Account } from '../config/index.js';
import { validateSessionInput, validateSessionTokenInput, resolveSessionCredential, saveSessionCredential, readSessionCredential, deleteSessionCredential, type SessionCredential } from './session.js';
import { validPersistedBan, type PersistedBan } from './kick-ban.js';

export interface ServerConnection { host: string; port: number; version: '1.8.9'; revision: number }
export interface PublicAccount {
  id: string; label: string; kind: 'MICROSOFT' | 'SESSION'; status: 'WAITING_FOR_LOGIN' | 'READY' | 'ERROR';
  minecraftName?: string; assignedBot?: string; createdAt: number; authError?: 'SESSION_TOKEN_INVALID'; ban?: PersistedBan;
}
type StoredAccount = (PublicAccount & { kind: 'MICROSOFT'; cacheKey: string; folder: string }) |
  (PublicAccount & { kind: 'SESSION'; minecraftName: string });
function transportAccount(account: StoredAccount): Account {
  return account.kind === 'SESSION'
    ? { label: account.label, username: account.minecraftName, auth: 'mojang', kind: 'SESSION', accountId: account.id }
    : { label: account.label, username: account.cacheKey, auth: 'microsoft' };
}
export interface PublicAuthChallenge { verificationUri: string; userCode: string; expiresAt: number }
interface AuthChallengeInput { verificationUri: string; userCode: string; expiresIn: number }
type MicrosoftAccountRef = { id?:string; label:string; cacheKey:string; folder:string };
type StartAuth = (
  account: MicrosoftAccountRef,
  config: Config,
  reportChallenge: (challenge: AuthChallengeInput) => void
) => Promise<{ minecraftName?: string } | void>;
type ResolveMicrosoftSession = (
  account: MicrosoftAccountRef,
  config: Config,
  reportChallenge: (challenge: AuthChallengeInput) => void
) => Promise<SessionCredential>;

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
  private botConfigurationAvailable: (botId:string)=>boolean = () => true;
  constructor(private config: Config, private startAuth: StartAuth,
    private resolveSession: (accessToken: string) => Promise<SessionCredential> = resolveSessionCredential,
    private resolveMicrosoftSession?: ResolveMicrosoftSession) {}
  setBotConfigurationGuard(guard:(botId:string)=>boolean):void { this.botConfigurationAvailable=guard; }
  get busy(): boolean { return this.pending > 0; }
  private uniqueLabel(base:string):string {
    const clean=(base.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,40)||'Account');
    const used=new Set(this.entries.map(account=>account.label.toLowerCase()));
    if(!used.has(clean.toLowerCase()))return clean;
    for(let n=2;n<=99;n++){
      const suffix=`-${n}`;
      const candidate=`${clean.slice(0,40-suffix.length)}${suffix}`;
      if(!used.has(candidate.toLowerCase()))return candidate;
    }
    return `Account-${randomUUID().slice(0,8)}`;
  }
  getServer(): ServerConnection { return { ...this.server }; }
  listAccounts(): PublicAccount[] {
    return this.entries.map(({ id, label, kind, status, minecraftName, assignedBot, createdAt, authError, ban }) =>
      ({ id, label, kind, status, minecraftName, assignedBot, createdAt, authError, ban }));
  }
  getAuthChallenge(id: string): PublicAuthChallenge | undefined {
    const challenge = this.challenges.get(id);
    if (!challenge) return undefined;
    if (challenge.expiresAt <= Date.now()) { this.challenges.delete(id); return undefined; }
    return { ...challenge };
  }
  private async cleanupDeletedMicrosoftCache(id:string,folder:string):Promise<void> {
    if(this.entries.some(account=>account.id===id))return;
    await rm(join(this.config.authDir,folder),{recursive:true,force:true}).catch(()=>{});
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
        /^[0-9a-f-]{36}$/.test(a.id) && /^[\w-]{1,40}$/.test(a.label) && ['MICROSOFT', 'SESSION'].includes(a.kind) &&
        ['WAITING_FOR_LOGIN', 'READY', 'ERROR'].includes(a.status) &&
        (a.authError === undefined || a.authError === 'SESSION_TOKEN_INVALID') &&
        (a.ban === undefined || validPersistedBan(a.ban)) &&
        (a.minecraftName === undefined || (typeof a.minecraftName === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(a.minecraftName))) &&
        (a.kind === 'MICROSOFT' ? typeof a.cacheKey === 'string' && a.cacheKey.length <= 256 && /^[\w-]{1,40}$/.test(a.folder) :
          ['READY', 'ERROR'].includes(a.status) && typeof a.minecraftName === 'string' && a.cacheKey === undefined && a.folder === undefined) &&
        Number.isSafeInteger(a.createdAt) && (a.assignedBot === undefined || /^bot-[1-9]\d*$/.test(a.assignedBot)))) throw Error('INVALID_RUNTIME_ACCOUNTS');
      this.entries = raw.map(a => ({ ...a, status: a.status === 'WAITING_FOR_LOGIN' ? 'ERROR' : a.status }));
      for (const a of this.entries) if (a.kind === 'SESSION') readSessionCredential(this.config.authDir, a.id);
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
  async bind(manager: BotManager): Promise<void> {
    this.manager = manager;
    manager.setSessionFailureHandler((botId, accountId) => this.revalidateSessionAfterConnectFailure(botId, accountId));
    manager.setBanDetectedHandler((botId, accountId, reason, detectedAt) =>
      this.persistBan(botId, accountId, reason, detectedAt));
    for (const a of this.entries) if (a.assignedBot) manager.assignAccount(a.assignedBot, a.id,
      transportAccount(a), a.minecraftName, a.ban);
    if (this.config.count === 1 && !this.entries.some(a => a.assignedBot)) {
      const ready = this.entries.filter(a => a.status === 'READY');
      if (ready.length === 1) {
        const account = ready[0]!;
        const updated = this.entries.map(a => a.id === account.id ? { ...a, assignedBot: 'bot-1' } : a);
        await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
        this.entries = updated;
        manager.assignAccount('bot-1', account.id,
          transportAccount(account), account.minecraftName, account.ban);
      }
    }
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.queue.then(task);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  private async persistBan(botId: string, accountId: string, reason: string, detectedAt: number): Promise<void> {
    return this.exclusive(async () => {
      const account = this.entries.find(a => a.id === accountId);
      const bot = this.manager?.views().find(value => value.id === botId);
      if (!account || account.assignedBot !== botId || bot?.accountId !== accountId || account.ban) return;
      const ban: PersistedBan = { kind:'BAN', reason, detectedAt };
      if (!validPersistedBan(ban)) return;
      const updated = this.entries.map(a => a.id === accountId ? { ...a, ban } : a);
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
      this.entries = updated;
    });
  }
  private async markSessionTokenInvalid(accountId: string): Promise<void> {
    const account = this.entries.find(a => a.id === accountId);
    if (!account || account.kind !== 'SESSION') return;
    const updated = this.entries.map(a => a.id === accountId && a.kind === 'SESSION'
      ? { ...a, status: 'ERROR' as const, authError: 'SESSION_TOKEN_INVALID' as const }
      : a);
    await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
    this.entries = updated;
    if (account.assignedBot) this.manager?.pauseForAccountError(account.assignedBot);
  }
  private async verifyStoredSession(account: Extract<StoredAccount, { kind: 'SESSION' }>): Promise<boolean> {
    try {
      const stored = readSessionCredential(this.config.authDir, account.id);
      const checked = await this.resolveSession(stored.accessToken);
      return checked.selectedProfile.id === stored.selectedProfile.id;
    } catch {
      return false;
    }
  }
  async getLaunchCredential(botId:string):Promise<SessionCredential> {
    return this.exclusive(async()=>{
      const bot=this.manager?.views().find(b=>b.id===botId);
      if(!bot)throw Error('UNKNOWN_BOT');
      if(!bot.accountId)throw Error('ACCOUNT_REQUIRED');
      const account=this.entries.find(a=>a.id===bot.accountId);
      if(!account||account.assignedBot!==botId)throw Error('ACCOUNT_REQUIRED');
      if(account.status!=='READY')throw Error('ACCOUNT_NOT_READY');

      if(account.kind==='SESSION'){
        let stored:SessionCredential;
        try{
          stored=readSessionCredential(this.config.authDir,account.id);
          const checked=await this.resolveSession(stored.accessToken);
          if(checked.selectedProfile.id!==stored.selectedProfile.id)throw Error('INVALID_SESSION_TOKEN');
          return checked;
        }catch{
          await this.markSessionTokenInvalid(account.id);
          throw Error('SESSION_AUTH_REQUIRED');
        }
      }

      if(!this.resolveMicrosoftSession)throw Error('AUTH_FAILED');
      try{
        return await this.resolveMicrosoftSession(
          account,
          this.config,
          challenge=>this.reportAuthChallenge(account.id,challenge)
        );
      }catch{
        const updated=this.entries.map(a=>a.id===account.id?{...a,status:'ERROR' as const}:a);
        await atomicJson(join(this.config.dataDir,'accounts-runtime.json'),updated);
        this.entries=updated;
        throw Error('AUTH_FAILED');
      }
    });
  }

  async prepareBotStart(botId: string): Promise<void> {
    return this.exclusive(async () => {
      const bot = this.manager?.views().find(b => b.id === botId);
      if (!bot) throw Error('UNKNOWN_BOT');
      if (!bot.accountId) return;
      const account = this.entries.find(a => a.id === bot.accountId);
      if (!account || account.kind !== 'SESSION') return;
      if (account.status === 'ERROR') throw Error('SESSION_AUTH_REQUIRED');
      if (!(await this.verifyStoredSession(account))) {
        await this.markSessionTokenInvalid(account.id);
        throw Error('SESSION_AUTH_REQUIRED');
      }
    });
  }
  private async revalidateSessionAfterConnectFailure(botId: string, accountId: string): Promise<boolean> {
    try {
      return await this.exclusive(async () => {
        const account = this.entries.find(a => a.id === accountId);
        const bot = this.manager?.views().find(b => b.id === botId);
        if (!account || account.kind !== 'SESSION' || bot?.accountId !== accountId) return false;
        if (account.status === 'ERROR') return true;
        const invalid = !(await this.verifyStoredSession(account));
        if (invalid) await this.markSessionTokenInvalid(account.id);
        return invalid;
      });
    } catch {
      return false;
    }
  }
  async startAssignedBots(): Promise<{ started: string[]; skipped: Array<{ botId: string; reason: string }> }> {
    if (!this.manager) throw Error('CONFLICT');
    const started: string[] = [], skipped: Array<{ botId: string; reason: string }> = [];
    for (const bot of this.manager.views()) {
      if (bot.state !== 'DISCONNECTED' || bot.startQueued) { skipped.push({ botId: bot.id, reason: bot.startQueued ? 'ALREADY_QUEUED' : 'NOT_DISCONNECTED' }); continue; }

      if (!bot.accountId) { skipped.push({ botId: bot.id, reason: 'UNASSIGNED' }); continue; }
      const account = this.entries.find(a => a.id === bot.accountId);
      if (!account || account.assignedBot !== bot.id) { skipped.push({ botId: bot.id, reason: 'UNASSIGNED' }); continue; }
      if (account.status !== 'READY') { skipped.push({ botId: bot.id, reason: 'ACCOUNT_NOT_READY' }); continue; }
      try {
        await this.prepareBotStart(bot.id);
        this.manager.connectBot(bot.id);
        started.push(bot.id);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'START_FAILED';
        skipped.push({ botId: bot.id, reason: ['SESSION_AUTH_REQUIRED','INVALID_STATE','CONFLICT'].includes(code) ? code : 'START_FAILED' });
      }
    }
    return { started, skipped };
  }
  stopAllBots(): { stopped: string[] } {
    if (!this.manager) throw Error('CONFLICT');
    return { stopped: this.manager.stopAllBots() };
  }
  saveServer(body: unknown): Promise<ServerConnection> {
    const valid = validateConnection(body);
    if (!this.manager?.allStopped()) throw Error('INVALID_STATE');
    return this.exclusive(async () => {
      return this.manager!.withConfigurationLock(() => this.manager!.allStopped(), async () => {
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
    if (b.kind === 'SESSION') return this.addSession(body);
    const keys=Object.keys(b).sort().join(',');
    if (!['kind','kind,label'].includes(keys) || b.kind !== 'MICROSOFT' ||
      (b.label !== undefined && (typeof b.label !== 'string' || !/^[\w-]{1,40}$/.test(b.label)))) throw Error('INVALID_INPUT');
    const requestedLabel=typeof b.label==='string'?b.label:undefined;
    return this.exclusive(async () => {
      if (this.entries.length >= 20 ||
          (requestedLabel && this.entries.some(a => a.label.toLowerCase() === requestedLabel.toLowerCase()))) throw Error('CONFLICT');
      const label=requestedLabel??this.uniqueLabel('Microsoft');
      const entry: StoredAccount = { id: randomUUID(), label, kind: 'MICROSOFT', status: 'WAITING_FOR_LOGIN',
        createdAt: Date.now(), cacheKey: label, folder: label };
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), [...this.entries, entry]);
      this.entries.push(entry);
      void this.startAuth(entry, this.config, challenge => this.reportAuthChallenge(entry.id, challenge))
        .then(result => this.authResult(entry.id, 'READY', result?.minecraftName), () => this.authResult(entry.id, 'ERROR'))
        .finally(() => this.cleanupDeletedMicrosoftCache(entry.id, entry.folder));
      return this.listAccounts().find(a => a.id === entry.id)!;
    });
  }
  private addSession(body: unknown): Promise<PublicAccount> {
    const { label:requestedLabel, accessToken } = validateSessionInput(body);
    return this.exclusive(async () => {
      if (this.entries.length >= 20 ||
          (requestedLabel && this.entries.some(a => a.label.toLowerCase() === requestedLabel.toLowerCase()))) throw Error('CONFLICT');
      const credential = await this.resolveSession(accessToken);
      const label=requestedLabel??this.uniqueLabel(credential.selectedProfile.name);
      const entry: StoredAccount = { id: randomUUID(), label, kind: 'SESSION', status: 'READY',
        minecraftName: credential.selectedProfile.name, createdAt: Date.now() };
      await saveSessionCredential(this.config.authDir, entry.id, credential);
      try {
        await this.manager!.withConfigurationLock(() => true, async () => {
          const shouldAssign = this.config.count === 1 && !this.entries.some(a => a.assignedBot || a.status === 'READY') &&
            this.manager!.isBotStopped('bot-1');
          if (shouldAssign) entry.assignedBot = 'bot-1';
          await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), [...this.entries, entry]);
          this.entries.push(entry);
          if (shouldAssign) this.manager!.assignAccount('bot-1', entry.id, transportAccount(entry), entry.minecraftName, entry.ban);
        });
      } catch {
        await deleteSessionCredential(this.config.authDir, entry.id);
        throw Error('SESSION_SAVE_FAILED');
      }
      return this.listAccounts().find(a => a.id === entry.id)!;
    });
  }
  replaceSessionToken(id: string, body: unknown): Promise<PublicAccount> {
    const accessToken = validateSessionTokenInput(body);
    return this.exclusive(async () => {
      const account = this.entries.find(a => a.id === id);
      if (!account) throw Error('UNKNOWN_ACCOUNT');
      if (account.kind !== 'SESSION') throw Error('CONFLICT');
      const botId = account.assignedBot;
      if (botId) {
        const bot = this.manager?.views().find(b => b.id === botId);
        if (!bot) throw Error('UNKNOWN_BOT');
        if (!this.manager!.isBotStopped(botId) || !this.botConfigurationAvailable(botId)) throw Error('INVALID_STATE');
      }
      const previous = readSessionCredential(this.config.authDir, id);
      const next = await this.resolveSession(accessToken);
      if (next.selectedProfile.id !== previous.selectedProfile.id) throw Error('PROFILE_MISMATCH');
      return this.manager!.withConfigurationLock(
        () => !botId || (this.manager!.isBotStopped(botId) && this.botConfigurationAvailable(botId)),
        async () => {
          await saveSessionCredential(this.config.authDir, id, next);
          try {
            const updated = this.entries.map(a => {
              if (a.id !== id || a.kind !== 'SESSION') return a;
              const { authError: _authError, ...rest } = a;
              return { ...rest, minecraftName: next.selectedProfile.name, status: 'READY' as const };
            });
            await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
            this.entries = updated;
            const current = this.entries.find(a => a.id === id)!;
            if (botId) this.manager!.assignAccount(botId, id, transportAccount(current), current.minecraftName, current.ban);
            return this.listAccounts().find(a => a.id === id)!;
          } catch (error) {
            await saveSessionCredential(this.config.authDir, id, previous).catch(() => {});
            throw error;
          }
        }
      );
    });
  }
  retryAccount(id: string): Promise<PublicAccount> {
    return this.exclusive(async () => {
      const account = this.entries.find(a => a.id === id);
      if (!account) throw Error('UNKNOWN_ACCOUNT');
      if (account.kind !== 'MICROSOFT' || account.status !== 'ERROR') throw Error('CONFLICT');
      const updated = this.entries.map(a => a.id === id ? { ...a, status: 'WAITING_FOR_LOGIN' as const } : a);
      await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
      this.entries = updated;
      this.challenges.delete(id);
      void this.startAuth(account, this.config, challenge => this.reportAuthChallenge(id, challenge))
        .then(result => this.authResult(id, 'READY', result?.minecraftName), () => this.authResult(id, 'ERROR'))
        .finally(() => this.cleanupDeletedMicrosoftCache(id, account.folder));
      return this.listAccounts().find(a => a.id === id)!;
    });
  }
  private async authResult(id: string, status: 'READY' | 'ERROR', minecraftName?: string): Promise<void> {
    this.challenges.delete(id);
    try { await this.exclusive(async () => {
      const cleanName = minecraftName && /^[A-Za-z0-9_]{1,16}$/.test(minecraftName) ? minecraftName : undefined;
      const account = this.entries.find(a => a.id === id);
      if (!account || account.kind !== 'MICROSOFT') return;
      const autoAssign = status === 'READY' && this.config.count === 1 &&
        !this.entries.some(a => a.assignedBot || (a.id !== id && a.status === 'READY')) &&
        this.manager?.isBotStopped('bot-1');
      if (autoAssign) {
        await this.manager!.withConfigurationLock(
          () => this.manager!.isBotStopped('bot-1'),
          async () => {
            const updated = this.entries.map(a => a.id === id ? {
              ...a, status, ...(cleanName ? { minecraftName: cleanName } : {}), assignedBot: 'bot-1'
            } : a);
            await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
            this.entries = updated;
            this.manager!.assignAccount('bot-1', id,
              transportAccount(account), cleanName, account.ban);
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
      if (!this.manager!.isBotStopped(botId) || !this.botConfigurationAvailable(botId)) throw Error('INVALID_STATE');
      if (accountId === null) {
        return this.manager!.withConfigurationLock(() => this.manager!.isBotStopped(botId) && this.botConfigurationAvailable(botId), async () => {
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
      return this.manager!.withConfigurationLock(() => this.manager!.isBotStopped(botId) && this.botConfigurationAvailable(botId), async () => {
        const updated = this.entries.map(a => a.id === accountId ? { ...a, assignedBot: botId } :
          a.assignedBot === botId ? { ...a, assignedBot: undefined } : a);
        await atomicJson(join(this.config.dataDir, 'accounts-runtime.json'), updated);
        this.entries = updated;
        this.manager!.assignAccount(botId, accountId, transportAccount(account), account.minecraftName, account.ban);
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
        if (!this.manager!.isBotStopped(botId) || !this.botConfigurationAvailable(botId)) throw Error('INVALID_STATE');
      }
      return this.manager!.withConfigurationLock(
        () => !botId || (this.manager!.isBotStopped(botId) && this.botConfigurationAvailable(botId)),
        async () => {
          const updated = this.entries.filter(a => a.id !== id);
          if (account.kind === 'SESSION') await deleteSessionCredential(this.config.authDir, id);
          else await rm(join(this.config.authDir, account.folder), { recursive:true, force:true });
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
