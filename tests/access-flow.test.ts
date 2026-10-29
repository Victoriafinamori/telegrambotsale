import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingInvitation, isPortalRoute } from '../web/access-flow.js';
function storage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      items.set(k, v);
    },
    removeItem: (k: string) => {
      items.delete(k);
    },
  };
}
test('Owner central, reseller and bot health routes reach the portal instead of the public landing', () => {
  for (const route of [
    '#/central',
    '#/revenda',
    '#/saude',
    '#/configuracao?step=bot',
    '#/convite?token=example',
  ])
    assert.equal(isPortalRoute(route), true);
  for (const route of ['#experiencia', '#pagamentos', '#/', '#/unknown'])
    assert.equal(isPortalRoute(route), false);
});
test('Invitation resumes after signup, navigation to login, reload and email return in another tab, then clears after acceptance', () => {
  const shared = storage(),
    token = 'a'.repeat(43);
  const first = new PendingInvitation(shared);
  assert.equal(first.read('#/convite?token=' + token), token);
  assert.equal(first.read('#/entrar'), token);
  first.markAccountCreated();
  const emailTab = new PendingInvitation(shared);
  assert.equal(emailTab.read('#/'), token);
  assert.equal(emailTab.accountCreated, true, 'Email return must not ask for signup again');
  assert.equal(
    emailTab.read('#/central'),
    null,
    'A pending invitation cannot hijack admin navigation',
  );
  emailTab.clear();
  assert.equal(
    first.read('#/entrar'),
    null,
    'Acceptance in another tab clears the original pending flow',
  );
  assert.equal(new PendingInvitation(shared).read('#/conta'), null);
});
test('Invitation storage expires, ignores unrelated token parameters and tolerates blocked or corrupt storage', () => {
  let now = 100;
  const saved = storage(),
    pending = new PendingInvitation(saved, () => now),
    token = 'b'.repeat(43);
  assert.equal(pending.read('#/comprar?token=' + token), null);
  pending.read('#/convite?token=' + token);
  now += 8 * 86400000;
  assert.equal(pending.read('#/entrar'), null);
  const broken = new PendingInvitation({
    getItem: () => '{bad',
    setItem: () => {
      throw Error();
    },
    removeItem: () => {
      throw Error();
    },
  });
  assert.equal(broken.read('#/convite?token=' + token), token);
  assert.equal(broken.read('#/entrar'), token);
  broken.clear();
  assert.equal(broken.read('#/entrar'), null);
});
