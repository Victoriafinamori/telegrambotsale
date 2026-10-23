import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './types.js';
export async function migrate(db: Database) {
  const directory = resolve('migrations');
  await db.query(
    'CREATE TABLE IF NOT EXISTS platform_schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const name of (await readdir(directory))
    .filter((v) => /^\d+_[a-z_]+\.sql$/.test(v))
    .sort()) {
    await db.transaction(async (tx) => {
      await tx.query('LOCK TABLE platform_schema_migrations IN EXCLUSIVE MODE');
      if (
        (await tx.query('SELECT name FROM platform_schema_migrations WHERE name=$1', [name])).rows
          .length
      )
        return;
      const sql = await readFile(resolve(directory, name), 'utf8');
      for (const statement of sql
        .split(';')
        .map((v) => v.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query('INSERT INTO platform_schema_migrations(name) VALUES($1)', [name]);
    });
  }
}
