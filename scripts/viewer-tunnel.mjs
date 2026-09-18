import 'dotenv/config';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const port = Number(process.env.VIEWER_PORT ?? '3007');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write('Invalid VIEWER_PORT.\n');
  process.exit(1);
}
const viewerUrl = `http://127.0.0.1:${port}/`;
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const runtimeFile = join(dataDir, 'viewer-public-url.json');

async function viewerReady() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(viewerUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (process.platform !== 'linux') {
  process.stderr.write('viewer:tunnel is intended for Linux/Codespaces testing.\n');
  process.exit(1);
}

const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
if (!arch) {
  process.stderr.write(`Unsupported architecture for test tunnel: ${process.arch}\n`);
  process.exit(1);
}

const toolsDir = join(process.cwd(), '.tools');
const binary = join(toolsDir, 'cloudflared');
await mkdir(toolsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

let haveBinary = false;
try {
  const info = await stat(binary);
  haveBinary = info.isFile() && info.size > 1_000_000;
} catch {}

if (!haveBinary) {
  const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  process.stdout.write('Downloading Cloudflare Tunnel helper...\n');
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(binary, bytes);
  await chmod(binary, 0o755);
}

if (!(await viewerReady())) {
  process.stdout.write(`Waiting for Viewer on ${viewerUrl} Start/connect ${process.env.VIEWER_BOT_ID ?? 'bot-1'}; this terminal can stay open.\n`);
}
while (!(await viewerReady())) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
}

process.stdout.write('\nStarting a temporary public HTTPS tunnel for the Viewer.\n');
process.stdout.write('BBot will publish the detected URL to BBot-Web automatically; no URL copy/paste is needed.\n');
process.stdout.write('This URL is public while this command is running. Stop this terminal when testing is finished.\n\n');

let publishedUrl;
async function publish(url) {
  if (publishedUrl === url) return;
  publishedUrl = url;
  await writeFile(runtimeFile, JSON.stringify({ url, pid: process.pid, createdAt: Date.now() }) + '\n', { mode: 0o600 });
  process.stdout.write(`\nViewer URL published to BBot-Web: ${url}\n\n`);
}

async function clearPublished() {
  try {
    const parsed = JSON.parse(await readFile(runtimeFile, 'utf8'));
    if (parsed?.pid === process.pid) await unlink(runtimeFile);
  } catch {}
}

const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', viewerUrl], { stdio: ['inherit', 'pipe', 'pipe'] });
let capture = '';
const inspect = chunk => {
  const text = chunk.toString();
  capture = (capture + text).slice(-8192);
  const match = capture.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  if (match) void publish(match[0]);
};
child.stdout.on('data', chunk => { process.stdout.write(chunk); inspect(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); inspect(chunk); });

child.on('error', error => {
  process.stderr.write(`Could not start cloudflared: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', async code => {
  await clearPublished();
  process.exitCode = code ?? 1;
});

let stopping = false;
const stop = signal => {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
