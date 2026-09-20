import net from 'node:net';
import readline from 'node:readline';

const host = '127.0.0.1';
const port = Number(process.env.BBOT_POC_BRIDGE_PORT ?? '3010');

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write('Invalid BBOT_POC_BRIDGE_PORT.\n');
  process.exit(1);
}

const controls = {
  forward: false,
  sprint: false,
  sneak: false,
  jump: false
};

let stateCount = 0;
let buffer = '';

function send(socket, message) {
  socket.write(JSON.stringify(message) + '\n');
}

function printHelp() {
  process.stdout.write(
    [
      '',
      'Commands:',
      '  forward on|off',
      '  sprint on|off',
      '  sneak on|off',
      '  jump on|off',
      '  look <yaw> <pitch>',
      '  chat <message>',
      '  release',
      '  help',
      '  quit',
      ''
    ].join('\n')
  );
}

function parseToggle(value) {
  if (value === 'on' || value === 'true' || value === '1') return true;
  if (value === 'off' || value === 'false' || value === '0') return false;
  return undefined;
}

const socket = net.createConnection({ host, port });

socket.setEncoding('utf8');
socket.setNoDelay(true);

socket.on('connect', () => {
  process.stdout.write(`Connected to Forge bridge at ${host}:${port}\n`);
  printHelp();
});

socket.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;

    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    try {
      const message = JSON.parse(line);
      if (message.type === 'state') {
        stateCount++;
        if (stateCount % 10 === 0) {
          process.stdout.write(
            `state pos=${message.x.toFixed(3)},${message.y.toFixed(3)},${message.z.toFixed(3)} ` +
            `yaw=${message.yaw.toFixed(1)} ground=${message.onGround} sprint=${message.sprinting} ` +
            `bridgeControl=${message.bridgeControl}\n`
          );
        }
      } else {
        process.stdout.write(`bridge: ${line}\n`);
      }
    } catch {
      process.stdout.write(`bridge(raw): ${line}\n`);
    }
  }
});

socket.on('error', error => {
  process.stderr.write(`Bridge connection error: ${error.message}\n`);
});

socket.on('close', () => {
  process.stdout.write('Bridge connection closed.\n');
  process.exit(0);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;

  const [command, ...args] = trimmed.split(/\s+/);

  if (command === 'forward' || command === 'sprint' || command === 'sneak' || command === 'jump') {
    const enabled = parseToggle(args[0]);
    if (enabled === undefined) {
      process.stdout.write(`Usage: ${command} on|off\n`);
      return;
    }

    controls[command] = enabled;
    send(socket, { type: 'controls', ...controls });
    return;
  }

  if (command === 'look') {
    const yaw = Number(args[0]);
    const pitch = Number(args[1]);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      process.stdout.write('Usage: look <yaw> <pitch>\n');
      return;
    }

    send(socket, { type: 'look', yaw, pitch });
    return;
  }

  if (command === 'chat') {
    const message = trimmed.slice('chat'.length).trim();
    if (!message) {
      process.stdout.write('Usage: chat <message>\n');
      return;
    }

    send(socket, { type: 'chat', message });
    return;
  }

  if (command === 'release') {
    controls.forward = false;
    controls.sprint = false;
    controls.sneak = false;
    controls.jump = false;
    send(socket, { type: 'release' });
    return;
  }

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'quit' || command === 'exit') {
    send(socket, { type: 'release' });
    socket.end();
    rl.close();
    return;
  }

  process.stdout.write('Unknown command. Type help.\n');
});

rl.on('SIGINT', () => {
  send(socket, { type: 'release' });
  socket.end();
  rl.close();
});
