import 'dotenv/config';
import { createInterface } from 'node:readline';
import { loadConfig } from './config/index.js';
import { Logger } from './logging/logger.js';
import { InstanceRegistry } from './instances/registry.js';
import { Scheduler } from './scheduler/scheduler.js';
import { PathfindingController } from './pathfinding/controller.js';
import { BotManager } from './bot/manager.js';
import { MockTransport } from './bot/mock.js';
import { MockEventProvider } from './events/provider.js';
import { MockTaskHandler } from './events/task.js';
import { JsonStore } from './core/store.js';
import { Application } from './core/application.js';
import { createManagementApi } from './api/server.js';
import { ControlStore } from './runtime/control.js';
import prismarineAuth from 'prismarine-auth';
import { join } from 'node:path';
const { Authflow, Titles } = prismarineAuth;
import type { TransportFactory } from './bot/transport.js';
async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, ...(process.argv.includes('--mock') ? { MODE: 'mock' } : {}) });
  if (config.inactiveMs <= config.suspectMs) throw new Error('INSTANCE_INACTIVE_MS must exceed INSTANCE_SUSPECT_MS');
  const controls = new ControlStore(config, async (account, settings) => {
    const auth = new Authflow(account.cacheKey, join(settings.authDir, account.folder),
      { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch },
      data => process.stderr.write(`[${account.label}] Microsoft sign-in: ${data.verification_uri} code: ${data.user_code}\n`));
    const result = await auth.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: false });
    if (!result.profile?.id) throw Error('AUTH_FAILED');
    // Access tokens stay inside prismarine-auth and its backend-only cache.
  });
  if (config.api.enabled && config.mode === 'live') await controls.load();
  const logger = new Logger(config.level, config.logDir, config.logMaxBytes, config.logFiles, config.accounts.map(a => a.username));
  let factory: TransportFactory;
  if (config.mode === 'mock') factory = (_index, events) => new MockTransport(events, () => `mock-pit-${1 + Math.floor(Math.random() * 3)}`);
  else {
    const { createMineflayerTransport } = await import('./bot/mineflayer.js');
    factory = (index, events) => createMineflayerTransport(config, index, events);
  }
  const registry = new InstanceRegistry(config.maxInstances);
  const scheduler = new Scheduler(config.jobMaxAttempts, config.maxJobs, config.jobRetryMs);
  const paths = new PathfindingController(config.pathConcurrency, config.pathTimeoutMs);
  const manager = new BotManager(config, factory, registry, scheduler, paths, new MockTaskHandler(), logger);
  if (config.api.enabled && config.mode === 'live') controls.bind(manager);
  // No actual API and no movement-producing mock events in live mode.
  const provider = new MockEventProvider(config.mode === 'mock' ? [1, 2, 3].map(n => ({
    id: `demo-${Date.now()}-${n}`, instanceId: `mock-pit-${n}`, target: { x: n * 5, y: 64, z: 5 }, type: 'mock', expiresAt: Date.now() + 300000
  })) : []);
  const app = new Application(manager, provider, new JsonStore(config.dataDir, config.mode), logger, config);
  const api = config.api.enabled ? createManagementApi(manager, config, logger, config.mode === 'live' ? controls : undefined) : undefined;
  const input = createInterface({ input: process.stdin, terminal: false });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; input.close(); await api?.close(); await app.stop(); setTimeout(() => process.exit(process.exitCode ?? 0), 10000).unref(); };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  input.on('line', line => {
    const [command, botId] = line.trim().split(/\s+/);
    if (command === 'quit') void stop();
    else if (command === 'status') logger.log('info', 'status', { bots: manager.views() });
    else if (command === 'recover' && botId) manager.notifyLobbyReturn(botId);
  });
  try { await api?.listen(); await app.start(); } catch (error) { input.close(); manager.stop(); await api?.close(); throw error; }
  logger.log('info', 'BBot started', { mode: config.mode, botCount: config.count, pathConcurrency: config.pathConcurrency });
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
