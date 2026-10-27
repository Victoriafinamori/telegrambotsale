import test from 'node:test';
import assert from 'node:assert/strict';
import { setupVisibility, rememberSetupDismissed } from '../web/setup-visibility.js';

test('Incomplete setup can be closed and resumed; preference stays scoped to its store', () => {
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      records.set(key, value);
    },
  };
  assert.equal(setupVisibility(false, 'visibility-shop-a', false, storage), 'open');
  rememberSetupDismissed('visibility-shop-a', true, storage);
  assert.equal(setupVisibility(false, 'visibility-shop-a', false, storage), 'closed');
  assert.equal(setupVisibility(false, 'visibility-shop-b', false, storage), 'open');
  const persisted = {
    getItem: (_key: string) => 'true',
    setItem: (_key: string, _value: string) => {},
  };
  assert.equal(setupVisibility(false, 'visibility-after-reload', false, persisted), 'closed');
  rememberSetupDismissed('visibility-shop-a', false, storage);
  assert.equal(setupVisibility(false, 'visibility-shop-a', false, storage), 'open');
});
test('Completed setup disappears automatically, including after later temporary loss of stock or connection', () => {
  assert.equal(setupVisibility(true, 'visibility-complete', false), 'complete');
  assert.equal(setupVisibility(false, 'visibility-complete', false), 'closed');
  assert.equal(setupVisibility(true, 'visibility-complete', true), 'open');
  assert.equal(setupVisibility(true, 'visibility-complete', false), 'complete');
});
test('An explicit review opens setup without discarding the saved closed preference; blocked storage still allows closing', () => {
  const storage = {
    getItem: (_key: string): string | null => {
      throw Error('blocked');
    },
    setItem: (_key: string, _value: string) => {
      throw Error('blocked');
    },
  };
  rememberSetupDismissed('visibility-blocked', true, storage);
  assert.equal(setupVisibility(false, 'visibility-blocked', false, storage), 'closed');
  assert.equal(setupVisibility(false, 'visibility-blocked', true, storage), 'open');
  assert.equal(setupVisibility(false, 'visibility-blocked', false, storage), 'closed');
});
