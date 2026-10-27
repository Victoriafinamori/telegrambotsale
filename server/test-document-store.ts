import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';

// A deliberately local adapter. BotStore receives this store, never production
// DocumentStore: every order, reservation, effect, audit and buyer stays in the copy.
export class TestDocumentStore implements DocumentStore {
  constructor(readonly records: Record<string, Doc> = {}) {}
  async get(path: string) {
    return structuredClone(this.records[path] ?? null);
  }
  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>) {
    const copy = structuredClone(this.records);
    const result = await work({
      get: async (path) => structuredClone(copy[path] ?? null),
      set: (path, value) => {
        copy[path] = structuredClone(value);
      },
      delete: (path) => {
        delete copy[path];
      },
    });
    for (const key of Object.keys(this.records)) delete this.records[key];
    Object.assign(this.records, copy);
    return result;
  }
  async list(
    collection: string,
    options: {
      offset?: number;
      limit: number;
      orderBy?: string;
      equals?: [string, unknown];
      afterId?: string;
    },
  ) {
    let values = Object.entries(this.records)
      .filter(
        ([path]) =>
          path.startsWith(collection + '/') &&
          path.split('/').length === collection.split('/').length + 1,
      )
      .map(([, value]) => structuredClone(value));
    if (options.equals)
      values = values.filter((value) => value[options.equals![0]] === options.equals![1]);
    if (options.orderBy)
      values.sort((a, b) => Number(b[options.orderBy!]) - Number(a[options.orderBy!]));
    if (options.afterId !== undefined)
      values = values
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .filter((value) => value.id > options.afterId!);
    return values.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit);
  }
}

export function encodeTestState(value: unknown): unknown {
  if (value instanceof Date) return { testDate: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeTestState);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeTestState(item)]),
    );
  return value;
}
export function decodeTestState(value: any): any {
  if (
    value &&
    typeof value === 'object' &&
    typeof value.testDate === 'string' &&
    Object.keys(value).length === 1
  )
    return new Date(value.testDate);
  if (Array.isArray(value)) return value.map(decodeTestState);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeTestState(item)]),
    );
  return value;
}
