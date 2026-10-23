import pg from 'pg';
import type { Connection, Database, Result } from './types.js';
export function postgres(url: string, ssl: boolean): Database {
  if ([...new URL(url).searchParams.keys()].some((key) => key.startsWith('ssl')))
    throw new Error('Configure DATABASE_SSL separadamente, sem opções ssl na URL.');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<Result<T>> {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async transaction<T>(fn: (db: Connection) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const value = await fn({
          async query<U>(sql: string, params: unknown[] = []) {
            const r = await c.query(sql, params);
            return { rows: r.rows as U[] };
          },
        });
        await c.query('COMMIT');
        return value;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
