import { PGlite } from '@electric-sql/pglite';
export { migrate } from '../server/migrations.js';
import type { Connection, Database, Result } from '../server/types.js';
export function embeddedDatabase(path?: string): Database {
  const db = new PGlite(path);
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<Result<T>> {
      return db.query<T>(sql, params);
    },
    async transaction<T>(fn: (c: Connection) => Promise<T>) {
      return db.transaction(async (tx) =>
        fn({ query: async <U>(sql: string, params: unknown[] = []) => tx.query<U>(sql, params) }),
      );
    },
    async close() {
      await db.close();
    },
  };
}
