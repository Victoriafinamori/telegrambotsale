import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerConfirmationContent } from '../web/onboarding.js';
test('Telegram confirmation offers an explicit status refresh beside the signed bot link', () => {
  const html = ownerConfirmationContent('https://t.me/ExampleBot?start=owner_example&test="');
  assert.match(html, /id="refresh-owner-confirmation"/);
  assert.match(html, /Já confirmei no Telegram · Atualizar situação/);
  assert.match(html, /href="https:\/\/t.me\/ExampleBot\?start=owner_example&amp;test=&quot;"/);
  assert.match(html, /Não digite apenas \/start/);
});
