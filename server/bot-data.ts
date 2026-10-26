import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { tokenHash } from './accounts.js';

export const botRoot = (id: string) => 'bot_shops/' + id;
export const botPath = (id: string, kind: string, key: string) =>
  botRoot(id) +
  '/' +
  kind +
  '/' +
  (/^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : 'invalid_' + tokenHash(key));
export const botButtons = (rows: [string, string][][]) => ({
  inline_keyboard: rows.map((row) => row.map(([text, callback_data]) => ({ text, callback_data }))),
});

// Firestore requires all reads before writes. Buffer writes until work finishes.
export async function botTransaction<T>(
  store: DocumentStore,
  work: (tx: DocumentTransaction) => Promise<T>,
) {
  return store.transaction(async (raw) => {
    const writes = new Map<string, Doc | null>();
    const reads = new Map<string, Promise<Doc | null>>();
    const tx: DocumentTransaction = {
      get: async (key) => {
        if (writes.has(key)) return structuredClone(writes.get(key)!);
        let read = reads.get(key);
        if (!read) {
          read = raw.get(key);
          reads.set(key, read);
        }
        return structuredClone(await read);
      },
      set: (key, value) => {
        writes.set(key, structuredClone(value));
      },
      delete: (key) => {
        writes.set(key, null);
      },
    };
    const result = await work(tx);
    for (const [key, value] of writes) value === null ? raw.delete(key) : raw.set(key, value);
    return result;
  });
}
