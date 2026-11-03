import type { Firestore, CollectionReference, DocumentReference } from 'firebase-admin/firestore';
import type { MigrationRow } from './central-migration.js';

// Recover operational roots before old proofs/rate logs when source quota is scarce.
const priority = [
  'resale_platform',
  'bot_shops',
  'merchant_accounts',
  'merchant_bot_setup',
  'merchant_bot_secrets',
  'bot_runtimes',
  'platform_payments',
  'platform_hosting',
  'resale_profiles',
  'purin_subaccount_claims',
  'platform_admins',
  'admin_mfa',
];
const rank = (name: string) => {
  const n = priority.indexOf(name);
  return n < 0 ? 100 : n;
};
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
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Error('Source read timed out')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export async function* exportFirestore(
  source: Pick<Firestore, 'listCollections' | 'getAll'>,
): AsyncGenerator<MigrationRow> {
  const roots = (await bounded(source.listCollections())).sort(
    (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
  );
  const references = new Map<string, DocumentReference[]>();
  const refs = async (ref: CollectionReference) => {
    let value = references.get(ref.path);
    if (!value) {
      value = await bounded(ref.listDocuments());
      references.set(ref.path, value);
    }
    return value;
  };
  async function* parents(ref: CollectionReference): AsyncGenerator<MigrationRow> {
    const documents = await refs(ref);
    for (let offset = 0; offset < documents.length; offset += 10) {
      const page = await bounded(source.getAll(...documents.slice(offset, offset + 10)));
      for (const doc of page)
        if (doc.exists) yield { path: doc.ref.path, value: convert(doc.data()) };
    }
  }
  async function* children(ref: CollectionReference): AsyncGenerator<MigrationRow> {
    for (const doc of await refs(ref)) {
      const collections = await bounded(doc.listCollections());
      collections.sort(
        (a, b) =>
          (a.id === 'products' ? -1 : 0) - (b.id === 'products' ? -1 : 0) ||
          a.id.localeCompare(b.id),
      );
      for (const child of collections) {
        yield* parents(child);
        yield* children(child);
      }
    }
  }
  for (const root of roots.filter((r) => rank(r.id) < 100)) yield* parents(root);
  for (const root of roots.filter((r) => rank(r.id) < 100)) yield* children(root);
  for (const root of roots.filter((r) => rank(r.id) === 100)) {
    yield* parents(root);
    yield* children(root);
  }
}
