import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtimeSources } from '../server/runtime-package.js';

// Explicit allowlist: customer bots receive no Admin SDK, server credentials,
// encryption keys, platform source or merchant data in their deployment package.
const destination = resolve('.local/bot-package-' + Date.now());
await mkdir(destination + '/dist-server/server', { recursive: true });
for (const [file, content] of Object.entries(await runtimeSources()))
  await writeFile(destination + '/' + file, content);
const lock = JSON.parse(await readFile('package-lock.json', 'utf8')),
  zod = lock.packages['node_modules/zod'];
if (!zod?.version || !zod.integrity) throw Error('Missing locked zod dependency');
const pkg = {
  name: 'blackout-merchant-bot',
  version: '0.1.0',
  private: true,
  type: 'module',
  engines: { node: '>=24.12.0' },
  scripts: { start: 'node dist-server/server/bot-runner.js' },
  dependencies: { zod: zod.version },
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
        'node_modules/zod': zod,
      },
    },
    null,
    2,
  ),
);
await copyFile('ops/squarecloud-bot.app.example', destination + '/squarecloud.app');
await writeFile(
  destination + '/runtime.env.example',
  'NODE_ENV=production\nPORT=80\nBOT_API_ORIGIN=https://blackout-create-api.hyzecloud.app\n# BOT_RUNTIME_KEY is a private, per-shop credential; inject it through the hosting environment.\n# Local pilot flags stay disabled until persistent storage and migration are verified.\n',
);
console.log(destination);
