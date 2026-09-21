import 'dotenv/config';
import { createInterface } from 'node:readline';
import { loadConfig } from './config/index.js';
import { Logger } from './logging/logger.js';
import { InstanceRegistry } from './instances/registry.js';
import { Scheduler } from './scheduler/scheduler.js';
import { PathfindingController } from './pathfinding/controller.js';
import { sharedPitNavigation } from './pathfinding/pit-navigation.js';
import { BotManager } from './bot/manager.js';
import { MockTransport } from './bot/mock.js';
import { HttpEventProvider, MockEventProvider, parseEventFeedV1 } from './events/provider.js';
import { BrookeCarePackageSchedule } from './events/brooke.js';
import { CarePackageCoordinator } from './events/care-package.js';
import { MockTaskHandler } from './events/task.js';
import { JsonStore } from './core/store.js';
import { Application } from './core/application.js';
import { createManagementApi } from './api/server.js';
import { ControlStore } from './runtime/control.js';
import prismarineAuth from 'prismarine-auth';
import { join } from 'node:path';
const { Authflow, Titles } = prismarineAuth;
import type { TransportFactory } from './bot/transport.js';
import type { ForgeWorkerSupervisor } from './forge/worker-supervisor.js';
async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, ...(process.argv.includes('--mock') ? { MODE: 'mock' } : {}) });
  if (config.inactiveMs <= config.suspectMs) throw new Error('INSTANCE_INACTIVE_MS must exceed INSTANCE_SUSPECT_MS');
  if(config.mode==='live'&&config.transport==='forge'){
    sharedPitNavigation.configurePersistence(join(config.dataDir,'pit-map-cache'));
  }
  const resolveMicrosoftCredential = async (
    account: { label:string; cacheKey:string; folder:string },
    settings: typeof config,
    reportChallenge: (challenge:{verificationUri:string;userCode:string;expiresIn:number})=>void
  ) => {
    const auth = new Authflow(account.cacheKey, join(settings.authDir, account.folder),
      { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' },
      data => {
        reportChallenge({ verificationUri: data.verification_uri, userCode: data.user_code, expiresIn: data.expires_in });
        process.stderr.write(`[${account.label}] Microsoft sign-in: ${data.verification_uri} code: ${data.user_code}\n`);
      });
    const result = await auth.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: false });
    const profile = result.profile as { id?:unknown; name?:unknown };
    const id = typeof profile?.id === 'string' ? profile.id.replace(/-/g,'').toLowerCase() : '';
    const minecraftName = typeof profile?.name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(profile.name) ? profile.name : '';
    if (typeof result.token !== 'string' || result.token.length === 0 || result.token.length > 2048 ||
        !/^[0-9a-f]{32}$/.test(id) || !minecraftName) throw Error('AUTH_FAILED');
    return { accessToken:result.token, selectedProfile:{ id, name:minecraftName } };
  };
  const controls = new ControlStore(
    config,
    async (account, settings, reportChallenge) => {
      const credential=await resolveMicrosoftCredential(account,settings,reportChallenge);
      return { minecraftName:credential.selectedProfile.name };
    },
    undefined,
    resolveMicrosoftCredential
  );
  if (config.api.enabled && config.mode === 'live') await controls.load();
  const logger = new Logger(config.level, config.logDir, config.logMaxBytes, config.logFiles, config.accounts.map(a => a.username));
  let forgeWorkers: ForgeWorkerSupervisor | undefined;
  if (config.mode === 'live' && config.transport === 'forge' && config.api.enabled) {
    const { ForgeWorkerSupervisor } = await import('./forge/worker-supervisor.js');
    forgeWorkers = new ForgeWorkerSupervisor(config, logger);
    controls.setBotConfigurationGuard(botId => forgeWorkers!.isStopped(botId));
  }
  let factory: TransportFactory;
  if (config.mode === 'mock') factory = (_index, events) => new MockTransport(events, () => `mock-pit-${1 + Math.floor(Math.random() * 3)}`);
  else if (config.transport === 'forge') {
    const { createForgeTransport } = await import('./bot/forge.js');
    factory = (index, events) => createForgeTransport(config, index, events);
  } else {
    const { createMineflayerTransport } = await import('./bot/mineflayer.js');
    factory = (index, events) => createMineflayerTransport(config, index, events);
  }
  const registry = new InstanceRegistry(config.maxInstances);
  const scheduler = new Scheduler(config.jobMaxAttempts, config.maxJobs, config.jobRetryMs);
  const paths = new PathfindingController(config.pathConcurrency, config.pathTimeoutMs);
  const carePackages = config.mode === 'live' ? new BrookeCarePackageSchedule() : undefined;
  const carePackageCoordinator = carePackages ? new CarePackageCoordinator(carePackages) : undefined;
  const manager = new BotManager(config, factory, registry, scheduler, paths, new MockTaskHandler(), logger,
    Date.now, Math.random, undefined, carePackageCoordinator);
  if (config.api.enabled && config.mode === 'live') await controls.bind(manager);
  const provider = config.mode === 'mock'
    ? new MockEventProvider([1, 2, 3].map(n => ({
        id: `demo-${Date.now()}-${n}`, instanceId: `mock-pit-${n}`, target: { x: n * 5, y: 64, z: 5 }, type: 'mock', expiresAt: Date.now() + 300000
      })))
    : config.eventProviderUrl
      ? new HttpEventProvider(new URL(config.eventProviderUrl), parseEventFeedV1, {
          timeoutMs: 10000, retries: 2, minIntervalMs: config.eventPollMs, maxBytes: 1_000_000, maxRetryMs: 60000
        })
      : new MockEventProvider([]);
  const app = new Application(manager, provider, new JsonStore(config.dataDir, config.mode), logger, config, carePackages);
  const api = config.api.enabled ? createManagementApi(manager, config, logger, config.mode === 'live' ? controls : undefined, carePackages, forgeWorkers) : undefined;
  const input = createInterface({ input: process.stdin, terminal: false });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    input.close();
    await api?.close();
    await app.stop();
    await forgeWorkers?.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 10000).unref();
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  input.on('line', line => {
    const [command, botId] = line.trim().split(/\s+/);
    if (command === 'quit') void stop();
    else if (command === 'status') logger.log('info', 'status', { bots: manager.views() });
    else if (command === 'recover' && botId) manager.notifyLobbyReturn(botId);
  });
  try { await api?.listen(); await app.start(); }
  catch (error) { input.close(); manager.stop(); await api?.close(); await forgeWorkers?.close(); throw error; }
  logger.log('info', 'BBot started', { mode: config.mode, transport: config.transport, botCount: config.count,
    pathConcurrency: config.pathConcurrency, eventProvider: config.eventProviderUrl ? 'http' : 'disabled' });
}
function safeStartupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (['INVALID_RUNTIME_CONFIG', 'INVALID_RUNTIME_ACCOUNTS'].includes(raw)) return raw;
  return 'Startup configuration or runtime error (details withheld)';
}
void main().catch(error => {
  process.stderr.write(`BBot startup failed: ${safeStartupError(error)}\nNo credentials were logged.\n`);
  process.exitCode = 1;
});
