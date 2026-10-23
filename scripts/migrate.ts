import 'dotenv/config';
import { postgres } from '../server/database.js';
import { migrate } from '../server/migrations.js';
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL no servidor.');
if (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'true')
  throw new Error('Migração em produção exige TLS no banco.');
const db = postgres(process.env.DATABASE_URL, process.env.DATABASE_SSL === 'true');
try {
  await migrate(db);
  console.log('Migração da plataforma aplicada.');
} finally {
  await db.close();
}
