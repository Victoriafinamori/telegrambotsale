import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFirestore } from '../server/firestore-export.js';
import type { Firestore } from 'firebase-admin/firestore';

test('Recovery exports core account/catalog roots before logs and preserves nested documents with absent parents', async () => {
  const values = new Map<string, any>([
    ['api_rate_limits/old', { count: 5 }],
    ['bot_shops/supplier', { title: 'Source' }],
    ['bot_shops/supplier/products/item', { units: ['ENCRYPTED'] }],
    ['merchant_accounts/supplier', { firebase_uid: 'owner' }],
    ['resale_suppliers/missing/grants/partner_item', { enabled: true, baseCents: 899 }],
    ['resale_platform/settings', { supplier_id: 'supplier' }],
  ]);
  const allPaths = [...values.keys(), 'resale_suppliers/missing'];
  const collection = (path: string): any => ({
    id: path.split('/').at(-1),
    path,
    listDocuments: async () =>
      [
        ...new Set(
          allPaths
            .filter((p) => p.startsWith(path + '/'))
            .map((p) =>
              p
                .split('/')
                .slice(0, path.split('/').length + 1)
                .join('/'),
            ),
        ),
      ].map(reference),
  });
  const reference = (path: string): any => ({
    path,
    listCollections: async () =>
      [
        ...new Set(
          allPaths
            .filter((p) => p.startsWith(path + '/'))
            .map((p) =>
              p
                .split('/')
                .slice(0, path.split('/').length + 1)
                .join('/'),
            ),
        ),
      ].map(collection),
  });
  const source = {
    listCollections: async () => [...new Set(allPaths.map((p) => p.split('/')[0]))].map(collection),
    getAll: async (...refs: any[]) =>
      refs.map((ref) => ({ ref, exists: values.has(ref.path), data: () => values.get(ref.path) })),
  } as unknown as Firestore;
  const rows = [];
  for await (const row of exportFirestore(source)) rows.push(row);
  assert.equal(rows.length, values.size);
  assert.equal(new Set(rows.map((r) => r.path)).size, values.size);
  assert.equal(rows[0].path, 'resale_platform/settings');
  assert.ok(
    rows.findIndex((r) => r.path === 'merchant_accounts/supplier') <
      rows.findIndex((r) => r.path === 'bot_shops/supplier/products/item'),
  );
  assert.ok(
    rows.findIndex((r) => r.path === 'bot_shops/supplier/products/item') <
      rows.findIndex((r) => r.path === 'api_rate_limits/old'),
  );
  assert.equal(rows.find((r) => r.path.endsWith('grants/partner_item'))?.value.baseCents, 899);
});
