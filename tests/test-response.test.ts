import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTestResponse } from '../web/test-response.js';
import type { TestMessage } from '../server/store-test.js';
const message = (
  id: number,
  turn?: number,
  audience: TestMessage['audience'] = 'buyer',
  delivery = false,
): TestMessage => ({ id, turn, audience, delivery, kind: 'text', text: 'Test', buttons: [] });
test('Latest response can edit an older message without exposing previous commands', () => {
  const messages = [message(1, 5), message(2, 2), message(3, 3, 'owner')];
  assert.deepEqual(
    currentTestResponse(messages, 'buyer').map((m) => m.id),
    [1],
  );
  assert.deepEqual(currentTestResponse(messages, 'owner'), []);
});
test('All delivery units in the latest response remain visible', () => {
  const messages = [
    message(1, 1),
    message(2, 2),
    message(3, 2, 'buyer', true),
    message(4, 2, 'buyer', true),
  ];
  assert.deepEqual(
    currentTestResponse(messages, 'buyer').map((m) => m.id),
    [2, 3, 4],
  );
});
test('Old saved sessions show only their final response', () => {
  assert.deepEqual(
    currentTestResponse([message(1), message(2)], 'buyer').map((m) => m.id),
    [2],
  );
});
