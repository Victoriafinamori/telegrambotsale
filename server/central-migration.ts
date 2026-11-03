import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import type { Doc } from './document-store.js';
import { SqliteDocumentStore } from './sqlite-document-store.js';

export interface MigrationRow {
  path: string;
  value: Doc;
}

// Deterministic logical contents, independent of export order and SQLite page layout.
// Run on an offline staging/restore database, never concurrently with live writes.
export async function centralContents(store: SqliteDocumentStore) {
  const digest = createHash('sha256'),
    counts: Record<string, number> = {};
  let after = '',
    total = 0;
  for (;;) {
    const rows = await store.scan(after, 500);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.path;
      if (row.path === 'central_metadata/migration') continue;
      const payload = serialize(row.value);
      digest.update(JSON.stringify([row.path, payload.length]));
      digest.update(payload);
      const collection = row.path.split('/').slice(0, -1).join('/');
      counts[collection] = (counts[collection] ?? 0) + 1;
      total++;
    }
  }
  return { total, counts, contentDigest: digest.digest('hex') };
}

export async function verifyCentralImport(
  store: SqliteDocumentStore,
  projectId: string,
  requireFinal = true,
) {
  const manifest = await store.get('central_metadata/migration');
  if (
    !manifest ||
    manifest.projectId !== projectId ||
    (requireFinal && manifest.verified !== true) ||
    manifest.total < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.contentDigest ?? '')
  )
    throw Error('Missing or unverified import manifest');
  const contents = await centralContents(store);
  if (
    contents.total !== manifest.total ||
    !isDeepStrictEqual(contents.counts, manifest.counts) ||
    contents.contentDigest !== manifest.contentDigest
  )
    throw Error('Imported contents do not match manifest');
  return { projectId, verified: manifest.verified === true, ...contents };
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
  const contents = await centralContents(target);
  if (contents.total !== total || !isDeepStrictEqual(contents.counts, counts))
    throw Error('Imported document totals do not match source');
  const manifest = {
    projectId,
    verified: sourceQuiesced,
    total,
    counts,
    digest: digest.digest('hex'),
    contentDigest: contents.contentDigest,
    completedAt: new Date(),
    source: 'firestore',
  };
  await target.transaction(async (tx) => tx.set('central_metadata/migration', manifest));
  return manifest;
}
