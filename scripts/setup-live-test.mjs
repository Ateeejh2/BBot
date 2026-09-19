import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = createInterface({ input, output });

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function setEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

try {
  console.log('BBot live-test setup (1 Microsoft account)');
  console.log('This script never asks for your Microsoft password or token.');

  if (await exists('.env') || await exists('accounts.json')) {
    const answer = (await rl.question('.env or accounts.json already exists. Overwrite both? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Canceled. Existing files were not changed.');
      process.exit(0);
    }
  }

  const username = (await rl.question('Microsoft account email: ')).trim();
  if (!username || username.length > 256) throw new Error('Invalid account email/identifier.');

  const host = (await rl.question('Minecraft server host: ')).trim();
  if (!/^[a-z\d.:_-]+$/i.test(host)) throw new Error('Invalid server host.');

  const portInput = (await rl.question('Minecraft server port [25565]: ')).trim();
  const port = portInput === '' ? 25565 : Number(portInput);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port.');

  let env = await readFile('.env.example', 'utf8');
  env = setEnvLine(env, 'MODE', 'live');
  env = setEnvLine(env, 'BOT_COUNT', '1');
  env = setEnvLine(env, 'SERVER_HOST', host);
  env = setEnvLine(env, 'SERVER_PORT', String(port));
  env = setEnvLine(env, 'MC_VERSION', '1.8.9');
  env = setEnvLine(env, 'ACCOUNTS_FILE', 'accounts.json');
  env = setEnvLine(env, 'DEBUG', 'true');
  env = setEnvLine(env, 'DISTRIBUTION_ENABLED', 'false');

  const accounts = [
    {
      label: 'test-01',
      username,
      auth: 'microsoft'
    }
  ];

  await writeFile('.env', env, { encoding: 'utf8', mode: 0o600 });
  await writeFile('accounts.json', JSON.stringify(accounts, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });

  console.log('');
  console.log('Created .env and accounts.json.');
  console.log('Both files are gitignored by this repository.');
  console.log('Next: npm run build && npm start');
  console.log('When Microsoft sign-in appears, use the shown URL/code yourself. Do not share the code or password.');
} finally {
  rl.close();
}
