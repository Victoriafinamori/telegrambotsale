import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit allowlist: customer bots receive no Admin SDK, server credentials,
// encryption keys, platform source or merchant data in their deployment package.
const destination = resolve('.local/bot-package-' + Date.now());
await mkdir(destination + '/dist-server/server', { recursive: true });
for (const file of ['bot-runner.js', 'telegram-client.js'])
  await copyFile('dist-server/server/' + file, destination + '/dist-server/server/' + file);
const lock = JSON.parse(await readFile('package-lock.json', 'utf8')),
  dotenv = lock.packages['node_modules/dotenv'];
if (!dotenv?.version || !dotenv.integrity) throw Error('Missing locked dotenv dependency');
const pkg = {
  name: 'blackout-merchant-bot',
  version: '0.1.0',
  private: true,
  type: 'module',
  engines: { node: '>=24.12.0' },
  scripts: { start: 'node dist-server/server/bot-runner.js' },
  dependencies: { dotenv: dotenv.version },
};
await writeFile(destination + '/package.json', JSON.stringify(pkg, null, 2));
await writeFile(
  destination + '/package-lock.json',
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: pkg.name,
          version: pkg.version,
          dependencies: pkg.dependencies,
          engines: pkg.engines,
        },
        'node_modules/dotenv': dotenv,
      },
    },
    null,
    2,
  ),
);
await copyFile('ops/squarecloud-bot.app.example', destination + '/squarecloud.app');
await writeFile(
  destination + '/runtime.env.example',
  'NODE_ENV=production\nPORT=80\nBOT_API_ORIGIN=https://blackout-create-api.squareweb.app\n# BOT_RUNTIME_KEY is a private, per-shop credential; inject it through the hosting environment.\n',
);
console.log(destination);
