import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const action = process.argv[2];
const args: Record<string, string[]> = {
  login: ['login'],
  status: ['login:list'],
  hosting: [
    'deploy',
    '--only',
    'hosting',
    '--config',
    '.local/firebase.hosting.json',
    '--project',
    'blackout-create',
  ],
  rules: ['deploy', '--only', 'firestore:rules,firestore:indexes', '--project', 'blackout-create'],
};
if (!args[action]) throw Error('Ação inválida.');
await mkdir('.local/cli-config', { recursive: true });
const child = spawn(
  process.execPath,
  [resolve('node_modules/firebase-tools/lib/bin/firebase.js'), ...args[action]],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      GOOGLE_APPLICATION_CREDENTIALS: '',
      XDG_CONFIG_HOME: resolve('.local/cli-config'),
    },
  },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
