import { readFile, writeFile } from 'node:fs/promises';

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
const inferredOrigin = codespaceName
  ? `https://${codespaceName}-${webPort}.${forwardingDomain}`
  : '';

env = setEnvLine(env, 'MODE', 'live');
env = setEnvLine(env, 'BOT_COUNT', '1');
env = setEnvLine(env, 'TRANSFER_MESSAGE_CHANNEL', 'chat');
env = setEnvLine(env, 'API_ENABLED', 'true');
env = setEnvLine(env, 'API_HOST', '127.0.0.1');
env = setEnvLine(env, 'API_PORT', '3008');
if (inferredOrigin) env = setEnvLine(env, 'API_ORIGIN', inferredOrigin);

await writeFile('.env', env, { encoding: 'utf8', mode: 0o600 });

process.stdout.write('BBot Web control settings applied to local .env.\n');
process.stdout.write('MODE=live, BOT_COUNT=1, TRANSFER_MESSAGE_CHANNEL=chat, API_ENABLED=true, API_HOST=127.0.0.1, API_PORT=3008\n');
if (inferredOrigin) {
  process.stdout.write(`API_ORIGIN=${inferredOrigin}\n`);
} else {
  process.stdout.write('API_ORIGIN was not changed because this is not a detected Codespace.\n');
}
process.stdout.write('Existing SERVER_HOST, account settings, and VIEWER_PUBLIC_URL were left untouched.\n');
