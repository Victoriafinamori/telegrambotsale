import 'dotenv/config';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, type CollectionReference } from 'firebase-admin/firestore';
import { resolve, dirname } from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { SqliteDocumentStore } from '../server/sqlite-document-store.js';
import { migrateCentral, type MigrationRow } from '../server/central-migration.js';

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
function convert(value: any): any {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw Error('Unsupported source document value');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
  }
  return value;
}
async function* collection(ref: CollectionReference): AsyncGenerator<MigrationRow> {
  // listDocuments includes missing parent documents: explicit reseller grants and
  // nested audit/history collections can exist without their parent being stored.
  const refs = await ref.listDocuments();
  for (let offset = 0; offset < refs.length; offset += 100) {
    const page = await source.getAll(...refs.slice(offset, offset + 100));
    for (const doc of page) {
      if (doc.exists) yield { path: doc.ref.path, value: convert(doc.data()) };
      for (const child of await doc.ref.listCollections()) yield* collection(child);
    }
  }
}
async function* documents(): AsyncGenerator<MigrationRow> {
  for (const root of await source.listCollections()) yield* collection(root);
}
try {
  // Without this explicit operator declaration, the result is a rehearsal and the
  // production startup guard refuses it. This flag does not stop source writers.
  const result = await migrateCentral(
    documents(),
    target,
    projectId,
    process.argv.includes('--source-quiesced'),
  );
  await target.backupTo(filename + '.verified-backup');
  console.log(
    JSON.stringify({
      documents: result.total,
      collections: Object.keys(result.counts).length,
      verified: result.verified,
      digest: result.digest,
      backupCreated: true,
    }),
  );
} catch (error) {
  // Keep the incomplete encrypted file for diagnosis; never mark it as verified.
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
