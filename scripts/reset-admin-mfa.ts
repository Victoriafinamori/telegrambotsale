import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { firebaseApp } from '../server/firebase.js';
import { loadConfig } from '../server/config.js';
import { adminPath } from '../server/firestore-platform.js';
import { tokenHash } from '../server/accounts.js';
const config = loadConfig(),
  index = process.argv.indexOf('--uid'),
  uid = process.argv[index + 1];
if (index < 0 || !uid || uid.length > 128 || config.PLATFORM_DATABASE !== 'firestore')
  throw Error(
    'Use admin:mfa-reset -- --uid UID com PLATFORM_DATABASE=firestore e credencial privada de servidor.',
  );
const app = firebaseApp(config),
  db = getFirestore(app);
try {
  await db.runTransaction(async (tx) => {
    if (!(await tx.get(db.doc(adminPath(uid)))).exists)
      throw Error('Administrador não encontrado.');
    tx.delete(db.doc('admin_mfa/' + tokenHash(uid)));
    tx.set(db.doc('platform_audit/' + randomUUID()), {
      actor_uid: 'server-bootstrap',
      subject_uid: uid,
      action: 'admin.mfa_reset',
      account_id: null,
      created_at: new Date(),
    });
  });
  await getAuth(app).revokeRefreshTokens(uid);
  console.log(
    'Autenticador removido e sessões revogadas. O administrador precisará configurar um novo segundo fator.',
  );
} finally {
  await db.terminate();
}
