import 'dotenv/config';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolve, dirname } from 'node:path';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { SqliteDocumentStore } from '../server/sqlite-document-store.js';
import { migrateCentral, verifyCentralImport } from '../server/central-migration.js';
import { exportFirestore } from '../server/firestore-export.js';

const projectId = process.env.FIREBASE_PROJECT_ID;
const key = process.env.PLATFORM_SQLITE_ENCRYPTION_KEY;
const destination = process.argv[2];
if (!projectId || !key || !destination)
  throw Error('Configure project, private SQLite key and a new staging destination');
// Exclusive creation prevents modifying any pre-existing file, even an empty database.
const filename = resolve(destination);
await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
const handle = await open(filename, 'wx', 0o600);
await handle.close();
const source = getFirestore(initializeApp({ projectId, credential: applicationDefault() }));
source.settings({ preferRest: true });
const target = new SqliteDocumentStore(filename, 'platform:' + projectId, key);
try {
  // Without this explicit operator declaration, the result is a rehearsal and the
  // production startup guard refuses it. This flag does not stop source writers.
  const result = await migrateCentral(
    exportFirestore(source),
    target,
    projectId,
    process.argv.includes('--source-quiesced'),
  );
  await target.backupTo(filename + '.verified-backup');
  const restored = new SqliteDocumentStore(
    filename + '.verified-backup',
    'platform:' + projectId,
    key,
  );
  try {
    await verifyCentralImport(restored, projectId, result.verified);
  } finally {
    await restored.close();
  }
  console.log(
    JSON.stringify({
      documents: result.total,
      collections: Object.keys(result.counts).length,
      verified: result.verified,
      digest: result.digest,
      backupCreated: true,
      backupRestoreVerified: true,
    }),
  );
} catch (error) {
  // Keep the incomplete encrypted file for diagnosis; never mark it as verified.
  await writeFile(
    filename + '.failure.json',
    JSON.stringify({
      category: error instanceof Error ? error.name : 'unknown',
      code: (error as { code?: unknown })?.code,
      message: error instanceof Error ? error.message : 'Unknown failure',
    }),
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      migrationFailed: true,
      category: error instanceof Error ? error.name : 'unknown',
    }),
  );
  process.exitCode = 1;
} finally {
  await target.close();
  await source.terminate();
}
