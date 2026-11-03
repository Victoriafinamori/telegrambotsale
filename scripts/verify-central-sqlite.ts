import 'dotenv/config';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SqliteDocumentStore } from '../server/sqlite-document-store.js';
import { verifyCentralImport } from '../server/central-migration.js';

// Offline inspection only: no Firebase requests, hosting changes or payment actions.
const projectId = process.env.FIREBASE_PROJECT_ID,
  key = process.env.PLATFORM_SQLITE_ENCRYPTION_KEY;
const input = process.argv[2];
if (!projectId || !key || !input)
  throw Error('Configure project, private key and existing imported file');
const filename = resolve(input);
if (!(await stat(filename)).isFile()) throw Error('Expected existing database file');
const store = new SqliteDocumentStore(filename, 'platform:' + projectId, key);
try {
  const result = await verifyCentralImport(store, projectId, !process.argv.includes('--rehearsal'));
  console.log(
    JSON.stringify({
      valid: true,
      verified: result.verified,
      documents: result.total,
      collections: Object.keys(result.counts).length,
      contentDigest: result.contentDigest,
    }),
  );
} catch {
  console.error(JSON.stringify({ valid: false, reason: 'Import or restore verification failed' }));
  process.exitCode = 1;
} finally {
  await store.close();
}
