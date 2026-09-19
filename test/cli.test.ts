import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('CLI mock starts, executes events, persists and quits cleanly', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbot-cli-'));
  const child = spawn(process.execPath, [resolve('dist/src/index.js'), '--mock'], {
    cwd: dir, env: { ...process.env, MODE: 'mock', BOT_COUNT: '1', DATA_DIR: dir, LOG_DIR: '', DEBUG: 'false', LOG_LEVEL: 'info', PLAY_COOLDOWN_MS: '1000', EVENT_POLL_MS: '100', DOTENV_CONFIG_PATH: join(dir, 'nonexistent.env') },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = ''; let errors = ''; let requested = false;
  child.stdout.on('data', data => {
    output += String(data);
    if (output.includes('job completed') && !requested) { requested = true; child.stdin.end('status\nquit\n'); }
  });
  child.stderr.on('data', data => { errors += String(data); });
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, errors); assert.ok(requested); assert.ok(output.includes('BBot stopped'));
    const snapshot = JSON.parse(await readFile(join(dir, 'mock-state.json'), 'utf8'));
    assert.ok(snapshot.jobs.some((job: { state: string }) => job.state === 'COMPLETED'));
  } finally { clearTimeout(timer); child.kill(); await rm(dir, { recursive: true, force: true }); }
});
