import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let viewerReady = false;
try {
  require.resolve('prismarine-viewer/package.json');
  require.resolve('canvas/package.json');
  viewerReady = true;
} catch {}

if (!viewerReady) {
  process.stdout.write('Installing Dashboard Viewer dependencies...\n');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['install', '--no-save', '--package-lock=false', 'prismarine-viewer@1.33.0', 'canvas@3.1.0'],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    process.stderr.write('Viewer dependency install failed. Web control settings were not changed.\n');
    process.exit(result.status ?? 1);
  }
}

function setEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

let env;
try {
  env = await readFile('.env', 'utf8');
} catch {
  env = await readFile('.env.example', 'utf8');
}

const codespaceName = process.env.CODESPACE_NAME?.trim();
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim() || 'app.github.dev';
const webPort = 5173;
const viewerPort = 3007;
const inferredOrigin = codespaceName
  ? `https://${codespaceName}-${webPort}.${forwardingDomain}`
  : '';
const inferredViewerUrl = codespaceName
  ? `https://${codespaceName}-${viewerPort}.${forwardingDomain}`
  : '';

env = setEnvLine(env, 'MODE', 'live');
env = setEnvLine(env, 'BOT_COUNT', '10');
env = setEnvLine(env, 'TRANSFER_MESSAGE_CHANNEL', 'chat');
env = setEnvLine(env, 'API_ENABLED', 'true');
env = setEnvLine(env, 'API_HOST', '127.0.0.1');
env = setEnvLine(env, 'API_PORT', '3008');
env = setEnvLine(env, 'VIEWER_ENABLED', 'true');
env = setEnvLine(env, 'VIEWER_BOT_ID', 'bot-1');
env = setEnvLine(env, 'VIEWER_PORT', String(viewerPort));
env = setEnvLine(env, 'VIEWER_VIEW_DISTANCE', '4');
env = setEnvLine(env, 'VIEWER_FIRST_PERSON', 'true');
if (inferredOrigin) env = setEnvLine(env, 'API_ORIGIN', inferredOrigin);
if (inferredViewerUrl) env = setEnvLine(env, 'VIEWER_PUBLIC_URL', inferredViewerUrl);

await writeFile('.env', env, { encoding: 'utf8', mode: 0o600 });

process.stdout.write('BBot Web control settings applied to local .env.\n');
process.stdout.write('MODE=live, BOT_COUNT=10, TRANSFER_MESSAGE_CHANNEL=chat, API_ENABLED=true, API_HOST=127.0.0.1, API_PORT=3008\n');
process.stdout.write('Viewer enabled for bot-1 on port 3007 (first-person, view distance 4).\n');
if (inferredOrigin) {
  process.stdout.write(`API_ORIGIN=${inferredOrigin}\n`);
  process.stdout.write(`VIEWER_PUBLIC_URL=${inferredViewerUrl}\n`);
  process.stdout.write('Dashboard Live View will use the Codespaces forwarded Viewer URL automatically.\n');
} else {
  process.stdout.write('API_ORIGIN / VIEWER_PUBLIC_URL were not changed because this is not a detected Codespace.\n');
}
process.stdout.write('Existing SERVER_HOST and account settings were left untouched.\n');
