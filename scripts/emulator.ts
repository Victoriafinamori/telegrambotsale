import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { emulatorEnv } from './emulator-env.js';
await mkdir('.local/cli-config', { recursive: true });
const command = process.argv.includes('--test')
  ? [
      'emulators:exec',
      '--only',
      'auth',
      '--project',
      'demo-blackout-create',
      'tsx --test tests/firebase.emulator.ts',
    ]
  : ['emulators:start', '--only', 'auth', '--project', 'demo-blackout-create'];
const child = spawn('./node_modules/.bin/firebase', command, {
  stdio: 'inherit',
  env: emulatorEnv(),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
