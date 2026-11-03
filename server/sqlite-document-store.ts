import { DatabaseSync, backup } from 'node:sqlite';
import { serialize, deserialize } from 'node:v8';
import type { Doc, DocumentStore, DocumentTransaction } from './document-store.js';
import { SecretVault } from './secret-vault.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// Encrypted transactional document storage for one process on a persistent volume.
export class SqliteDocumentStore implements DocumentStore {
  private readonly db: DatabaseSync;
  private readonly vault: SecretVault;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  constructor(
    filename: string,
    readonly namespace: string,
    key: string,
    private readonly allowedPath: (path: string) => boolean = () => true,
  ) {
    if (!namespace) throw Error('Database namespace is required');
    this.vault = new SecretVault(key);
    this.vault.requireKey();
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity (account TEXT PRIMARY KEY, proof TEXT NOT NULL);`);
    const owner = this.db.prepare('SELECT account,proof FROM identity').get();
    if (owner && owner.account !== namespace) {
      this.db.close();
      throw Error('Local database belongs to another shop');
    }
    try {
      if (
        owner &&
        this.vault.open(String(owner.proof), 'local-identity:' + namespace) !== namespace
      )
        throw Error('Invalid local identity');
      this.db
        .prepare('INSERT OR IGNORE INTO identity(account,proof) VALUES (?,?)')
        .run(namespace, this.vault.seal(namespace, 'local-identity:' + namespace));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private assertPath(path: string) {
    if (!this.allowedPath(path))
      throw Error('Local store cannot access central or other shop data');
    if (path.split('/').some((part) => !part || part === '.' || part === '..'))
      throw Error('Invalid document path');
  }
  private read(path: string): Doc | null {
    this.assertPath(path);
    const row = this.db.prepare('SELECT payload FROM documents WHERE path=?').get(path);
    return row
      ? deserialize(Buffer.from(this.vault.open(String(row.payload), path), 'base64'))
      : null;
  }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(Error('Local store is closed'));
    // Existing domain handlers query lists while inside their transaction. Run
    // these reads on the same snapshot, while unrelated requests remain queued.
    if (this.context.getStore()?.active) return work();
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }
  get(path: string): Promise<Doc | null> {
    return this.schedule(async () => this.read(path));
  }
  transaction<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active)
      return Promise.reject(Error('Nested transactions are not supported'));
    return this.schedule(async () => {
      return this.context.run({ active: true }, async () => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const result = await work({
            get: async (path) => this.read(path),
            set: (path, value) => {
              this.assertPath(path);
              this.db
                .prepare('INSERT OR REPLACE INTO documents(path,payload) VALUES (?,?)')
                .run(path, this.vault.seal(serialize(value).toString('base64'), path));
            },
            delete: (path) => {
              this.assertPath(path);
              this.db.prepare('DELETE FROM documents WHERE path=?').run(path);
            },
          });
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        } finally {
          this.context.getStore()!.active = false;
        }
      });
    });
  }
  list(collection: string, options: Parameters<DocumentStore['list']>[1]): Promise<Doc[]> {
    return this.schedule(async () => {
      this.assertPath(collection);
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
        throw Error('Invalid local query limit');
      if (options.orderBy && options.afterId !== undefined)
        throw Error('Document cursor cannot be combined with field ordering');
      // Collection membership is exact, including nested collections; no LIKE wildcards.
      const rows = this.db
        .prepare('SELECT path FROM documents WHERE substr(path,1,?)=? ORDER BY path')
        .all(collection.length + 1, collection + '/');
      let values = rows
        .filter((row) => String(row.path).split('/').length === collection.split('/').length + 1)
        .map((row) => this.read(String(row.path))!);
      if (options.equals) {
        const [field, value] = options.equals;
        values = values.filter((row) => row[field] === value);
      }
      if (options.afterId !== undefined) values = values.filter((row) => row.id > options.afterId!);
      if (options.orderBy) {
        const field = options.orderBy;
        values.sort((a, b) => (a[field] < b[field] ? 1 : a[field] > b[field] ? -1 : 0));
      }
      const offset = options.offset ?? 0;
      return values.slice(offset, offset + options.limit);
    });
  }
  backupTo(filename: string): Promise<void> {
    return this.schedule(async () => {
      await backup(this.db, filename);
    });
  }
  scan(afterPath = '', limit = 100): Promise<{ path: string; value: Doc }[]> {
    return this.schedule(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid scan limit');
      return this.db
        .prepare('SELECT path FROM documents WHERE path > ? ORDER BY path LIMIT ?')
        .all(afterPath, limit)
        .map((row) => ({ path: String(row.path), value: this.read(String(row.path))! }));
    });
  }
  async close() {
    this.closed = true;
    await this.pending;
    this.db.close();
  }
}
