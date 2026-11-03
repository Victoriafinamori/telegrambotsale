import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import type { Doc } from './document-store.js';
import { SqliteDocumentStore } from './sqlite-document-store.js';

export interface MigrationRow {
  path: string;
  value: Doc;
}
// Import to an EMPTY staging database. Never overwrites an operating platform.
// The caller must stop all source writers before a final, production-ready export.
export async function migrateCentral(
  source: AsyncIterable<MigrationRow>,
  target: SqliteDocumentStore,
  projectId: string,
  sourceQuiesced = false,
) {
  if ((await target.scan('', 1)).length) throw Error('Migration requires an empty destination');
  const counts: Record<string, number> = {};
  const digest = createHash('sha256');
  let total = 0;
  for await (const row of source) {
    if (row.path === 'central_metadata/migration')
      throw Error('Unexpected source migration marker');
    const parts = row.path.split('/');
    if (parts.length % 2 || parts.some((p) => !p || p === '.' || p === '..'))
      throw Error('Invalid source document path');
    await target.transaction(async (tx) => {
      if (await tx.get(row.path)) throw Error('Duplicate source document');
      tx.set(row.path, row.value);
    });
    const saved = await target.get(row.path);
    if (!isDeepStrictEqual(saved, row.value))
      throw Error('Imported document does not match source');
    const payload = serialize(row.value);
    digest.update(JSON.stringify([row.path, payload.length]));
    digest.update(payload);
    const collection = parts.slice(0, -1).join('/');
    counts[collection] = (counts[collection] ?? 0) + 1;
    total++;
  }
  if (!total) throw Error('Refusing to mark an empty central database as migrated');
  const manifest = {
    projectId,
    verified: sourceQuiesced,
    total,
    counts,
    digest: digest.digest('hex'),
    completedAt: new Date(),
    source: 'firestore',
  };
  await target.transaction(async (tx) => tx.set('central_metadata/migration', manifest));
  return manifest;
}
