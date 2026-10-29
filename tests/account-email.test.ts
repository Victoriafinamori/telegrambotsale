import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestorePlatform } from '../server/firestore-platform.js';
import { MemoryDocuments } from './document-memory.js';
import { fixture } from './helpers.js';
import type { AccountService } from '../server/platform-contract.js';

async function correction(p: AccountService) {
  const registration = {
    name: 'João',
    email: 'wrong@example.test',
    storeName: 'ICIA',
    channel: 'telegram' as const,
    reference: 'contract',
    priceCents: 999,
  };
  const a = await p.register(registration, 'admin');
  await p.confirm(a.id, 'admin');
  const old = await p.invite(a.id, 'admin');
  const value = { expectedEmail: a.email, email: '  Correct@Example.test  ' };
  const changed = await p.changeEmail(a.id, value, 'admin');
  assert.equal(changed.email, 'correct@example.test');
  assert.equal(changed.id, a.id);
  assert.equal(changed.reference, 'contract');
  assert(changed.purchase_confirmed_at);
  await assert.rejects(() => p.inspect(old.token), { code: 'INVITE_UNAVAILABLE' });
  await p.changeEmail(a.id, value, 'admin'); // Lost-response retry is harmless.
  await assert.rejects(
    () => p.changeEmail(a.id, { ...value, email: 'third@example.test' }, 'admin'),
    { code: 'ACCOUNT_CHANGED' },
  );
  await p.register({ ...registration, email: 'occupied@example.test' }, 'admin');
  await assert.rejects(
    () =>
      p.changeEmail(
        a.id,
        { expectedEmail: changed.email, email: 'occupied@example.test' },
        'admin',
      ),
    { code: 'EMAIL_EXISTS' },
  );
  await p.register(registration, 'admin'); // Old email claim was released.
  const invite = await p.invite(a.id, 'admin');
  await assert.rejects(
    () =>
      p.accept(invite.token, {
        uid: 'wrong',
        email: a.email,
        emailVerified: true,
        authTime: Date.now() / 1000,
      }),
    { code: 'INVITE_EMAIL_MISMATCH' },
  );
  await p.accept(invite.token, {
    uid: 'right',
    email: changed.email,
    emailVerified: true,
    authTime: Date.now() / 1000,
  });
  await assert.rejects(
    () =>
      p.changeEmail(a.id, { expectedEmail: changed.email, email: 'other@example.test' }, 'admin'),
    { code: 'EMAIL_LINKED' },
  );
  assert.equal((await p.own('right'))?.id, a.id);
  assert((await p.history()).some((e: any) => e.action === 'account.email_corrected'));
}
test('Firestore email correction preserves contract, replaces unique claim, invalidates invitation and protects linked identity', async () => {
  await correction(new FirestorePlatform(new MemoryDocuments()));
});
test('SQL email correction preserves contract, releases old email and protects invitation identity', async () => {
  const f = await fixture();
  try {
    await correction(f.accounts);
  } finally {
    await f.close();
  }
});
