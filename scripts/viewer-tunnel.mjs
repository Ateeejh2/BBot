import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const viewerUrl = 'http://127.0.0.1:3007/';

async function viewerReady() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(viewerUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (!(await viewerReady())) {
  process.stderr.write('Viewer is not reachable on 127.0.0.1:3007. Start BBot first and wait for "viewer started".\n');
  process.exit(1);
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

process.stdout.write('\nStarting a temporary public HTTPS tunnel for the Viewer.\n');
process.stdout.write('Copy the https://...trycloudflare.com URL into BBot-Web > Live View > Viewer URL.\n');
process.stdout.write('This URL is public while this command is running. Stop this terminal when testing is finished.\n\n');

const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', viewerUrl], { stdio: 'inherit' });
child.on('error', error => {
  process.stderr.write(`Could not start cloudflared: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
