import 'dotenv/config';
import { getAuth } from 'firebase-admin/auth';
import { getApp } from 'firebase-admin/app';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { firebaseIdentity } from '../server/firebase.js';
import { postgres } from '../server/database.js';
const config = loadConfig(),
  uid = process.argv[process.argv.indexOf('--uid') + 1],
  revoke = process.argv.includes('--revoke');
if (!process.argv.includes('--uid') || !uid || uid.length > 128)
  throw new Error('Use npm run admin:grant -- --uid UID [--revoke].');
if (!config.DATABASE_URL) throw new Error('Configure DATABASE_URL.');
firebaseIdentity(config);
const user = await getAuth(getApp(config.FIREBASE_PROJECT_ID)).getUser(uid);
if (!revoke && (!user.emailVerified || user.disabled))
  throw new Error('O administrador precisa de e-mail confirmado e conta habilitada.');
const db = postgres(config.DATABASE_URL, config.DATABASE_SSL === 'true');
try {
  await db.transaction(async (tx) => {
    await tx.query(
      revoke
        ? 'DELETE FROM platform_admins WHERE firebase_uid=$1'
        : 'INSERT INTO platform_admins(firebase_uid) VALUES($1) ON CONFLICT DO NOTHING',
      [uid],
    );
    await tx.query(
      'INSERT INTO platform_audit(id,actor_uid,action,subject_uid) VALUES($1,$2,$3,$4)',
      [randomUUID(), 'server-bootstrap', revoke ? 'admin.revoked' : 'admin.granted', uid],
    );
  });
  if (revoke) await getAuth(getApp(config.FIREBASE_PROJECT_ID)).revokeRefreshTokens(uid);
  console.log(
    revoke ? 'Permissão administrativa removida.' : 'Permissão administrativa concedida.',
  );
} finally {
  await db.close();
}
