import { FieldPath, type Firestore, type Transaction } from 'firebase-admin/firestore';
export type Doc = Record<string, any>;
export interface DocumentTransaction {
  get(path: string): Promise<Doc | null>;
  set(path: string, value: Doc): void;
  delete(path: string): void;
}
export interface DocumentStore {
  get(path: string): Promise<Doc | null>;
  transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
  list(
    collection: string,
    options: {
      offset?: number;
      limit: number;
      orderBy?: string;
      equals?: [string, unknown];
      afterId?: string;
    },
  ): Promise<Doc[]>;
}
// Timestamp objects stay on the server; the domain works with Date like PostgreSQL.
function dates(value: any): any {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (Array.isArray(value)) return value.map(dates);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dates(item)]));
  return value;
}
export class FirestoreDocumentStore implements DocumentStore {
  constructor(readonly firestore: Firestore) {}
  async get(path: string) {
    const value = await this.firestore.doc(path).get();
    return value.exists ? dates(value.data()) : null;
  }
  async transaction<T>(work: (tx: DocumentTransaction) => Promise<T>) {
    return this.firestore.runTransaction((tx: Transaction) =>
      work({
        get: async (path) => {
          const value = await tx.get(this.firestore.doc(path));
          return value.exists ? dates(value.data()) : null;
        },
        set: (path, value) => {
          tx.set(this.firestore.doc(path), value);
        },
        delete: (path) => {
          tx.delete(this.firestore.doc(path));
        },
      }),
    );
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
    let query: FirebaseFirestore.Query = this.firestore.collection(collection);
    if (options.equals) query = query.where(options.equals[0], '==', options.equals[1]);
    if (options.orderBy) query = query.orderBy(options.orderBy, 'desc');
    if (options.afterId !== undefined) {
      if (options.orderBy) throw Error('Document cursor cannot be combined with field ordering');
      query = query.orderBy(FieldPath.documentId());
      if (options.afterId) query = query.startAfter(options.afterId);
    }
    const values = await query
      .offset(options.offset ?? 0)
      .limit(options.limit)
      .get();
    return values.docs.map((d) => dates(d.data()));
  }
}
