import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function setEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['install', '--no-save', '--package-lock=false', 'prismarine-viewer@1.33.0', 'canvas@3.1.0'], { stdio: 'inherit' });
if (result.status !== 0) {
  process.stderr.write('Viewer install failed (prismarine-viewer/canvas). BBot files were not changed.\n');
  process.exit(result.status ?? 1);
}

let env;
try {
  env = await readFile('.env', 'utf8');
} catch {
  env = await readFile('.env.example', 'utf8');
}
env = setEnvLine(env, 'VIEWER_ENABLED', 'true');
env = setEnvLine(env, 'VIEWER_BOT_ID', 'bot-1');
env = setEnvLine(env, 'VIEWER_PORT', '3007');
env = setEnvLine(env, 'VIEWER_VIEW_DISTANCE', '4');
env = setEnvLine(env, 'VIEWER_FIRST_PERSON', 'true');
await writeFile('.env', env, { encoding: 'utf8', mode: 0o600 });

process.stdout.write('Viewer ready for bot-1 on port 3007. Restart BBot with npm start.\n');
process.stdout.write('For remote BBot-Web testing, expose port 3007 only for the test session and use its HTTPS URL in Live View.\n');
