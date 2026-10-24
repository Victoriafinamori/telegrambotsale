import type { Doc, DocumentStore } from '../server/document-store.js';
// Domain test adapter, not a Firestore emulator or production database.
export class MemoryDocuments implements DocumentStore {
  private records = new Map<string, Doc>();
  private pending: Promise<unknown> = Promise.resolve();
  async get(path: string) {
    return structuredClone(this.records.get(path) ?? null);
  }
  async transaction<T>(work: Parameters<DocumentStore['transaction']>[0]): Promise<T> {
    const next = this.pending.then(async () => {
      const copy = structuredClone(this.records);
      let writing = false;
      const result = await work({
        get: async (path) => {
          if (writing) throw Error('Firestore forbids reads after writes in a transaction');
          return structuredClone(copy.get(path) ?? null);
        },
        set: (path, value) => {
          writing = true;
          copy.set(path, structuredClone(value));
        },
        delete: (path) => {
          writing = true;
          copy.delete(path);
        },
      });
      this.records = copy;
      return result as T;
    });
    this.pending = next.catch(() => {});
    return next;
  }
  async list(
    collection: string,
    options: { offset?: number; limit: number; orderBy?: string; equals?: [string, unknown] },
  ) {
    let values = [...this.records]
      .filter(([path]) => path.startsWith(collection + '/') && path.split('/').length === 2)
      .map(([, data]) => structuredClone(data));
    if (options.equals) values = values.filter((d) => d[options.equals![0]] === options.equals![1]);
    if (options.orderBy)
      values.sort((a, b) => Number(b[options.orderBy!]) - Number(a[options.orderBy!]));
    return values.slice(options.offset || 0, (options.offset || 0) + options.limit);
  }
}
