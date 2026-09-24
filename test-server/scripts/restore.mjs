import { copyFile, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const backup=resolve('test-server/runtime/bbot-env-backup');
try{await stat(backup)}catch{process.stderr.write('No test-server .env backup exists.\n');process.exit(1)}
await copyFile(backup,resolve('.env'));
await unlink(backup);
process.stdout.write('Restored the pre-test BBot .env. Restart BBot before using the normal server again.\n');
