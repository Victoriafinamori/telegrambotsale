import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runtimeZip } from '../server/square-hosting.js';
import { buildHyzeRuntimeArchive } from '../server/hyze-hosting.js';
import { spawnSync } from 'node:child_process';

// Deployment artifacts contain compiled code and manifests, never production envs.
const files: Record<string, Uint8Array | string> = {};
async function collect(directory: string) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, item.name);
    if (item.isDirectory()) await collect(filename);
    else if (item.isFile()) files[filename.replaceAll('\\', '/')] = await readFile(filename);
  }
}
await collect('dist-server');
await collect('dist');
const destination = resolve('.local/hyze-migration-' + Date.now());
await mkdir(destination, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
delete manifest.devDependencies;
manifest.dependencies.node = '24.18.0';
manifest.scripts = { start: './node_modules/node/bin/node hyze-start.mjs' };
await writeFile(join(destination, 'package.json'), JSON.stringify(manifest, null, 2));
// Generate a production-only lock. Hyze must not rebuild this compiled artifact.
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: destination, shell: process.platform === 'win32', stdio: 'inherit' },
);
if (result.status !== 0) throw Error('Unable to lock the Hyze production manifest');
for (const file of ['package.json', 'package-lock.json'])
  files[file] = await readFile(join(destination, file));
files['hyze-start.mjs'] = `import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Blackout requires Node 24 or newer');
const raw = process.env.BLACKOUT_FIREBASE_ADMIN_JSON;
if (!raw) throw Error('Configure the private Firebase service identity before starting');
let identity;
try {identity = JSON.parse(raw);} catch {throw Error('Invalid private Firebase identity');}
if(identity.project_id !== process.env.FIREBASE_PROJECT_ID || !identity.client_email?.endsWith('.iam.gserviceaccount.com') || !identity.private_key?.includes('BEGIN PRIVATE KEY')) throw Error('Firebase identity does not match the configured project');
const folder=resolve('.runtime-secrets');
await mkdir(folder,{recursive:true,mode:0o700});
process.env.GOOGLE_APPLICATION_CREDENTIALS=resolve(folder,'firebase-admin.json');
await writeFile(process.env.GOOGLE_APPLICATION_CREDENTIALS,raw,{mode:0o600});
delete process.env.BLACKOUT_FIREBASE_ADMIN_JSON;
process.env.NODE_ENV='production';
process.env.HOST='0.0.0.0';
process.env.PORT ||= '3000';
await import('./dist-server/server/main.js');
`;
await writeFile(join(destination, 'blackout-api.zip'), runtimeZip(files));
await writeFile(
  join(destination, 'blackout-bot-template.zip'),
  await buildHyzeRuntimeArchive('Blackout-00000000-0000-4000-8000-000000000000'),
);
await writeFile(
  join(destination, 'private-env.example'),
  `# Placeholders only. Install through Hyze private env settings, never inside the ZIP.
FIREBASE_PROJECT_ID=blackout-create
PLATFORM_DATABASE=firestore
API_AUTH_MODE=bearer
APP_ORIGIN=https://blackout-create.web.app
API_PUBLIC_ORIGIN=https://REPLACE_WITH_THE_REAL_API_ORIGIN
TRUST_PROXY_HOPS=1
FIRESTORE_PREFER_REST=true
BOT_TOKEN_ENCRYPTION_KEY=KEEP_THE_EXISTING_PRIVATE_KEY
ADMIN_MFA_ENCRYPTION_KEY=KEEP_THE_EXISTING_DIFFERENT_PRIVATE_KEY
BLACKOUT_FIREBASE_ADMIN_JSON=INSTALL_PRIVATE_RUNTIME_SERVICE_ACCOUNT_JSON
# NODE_ENV and PORT are reserved by Hyze. hyze-start.mjs sets production/HOST internally.
# Start command: ./node_modules/node/bin/node hyze-start.mjs; exposed port: 3000; API memory: 512 MB.
`,
);
console.log(destination);
