import type { TestMessage } from '../server/store-test.js';

// Navigation can edit an old message id. Response order follows the engine turn,
// never the message id or its original position in the persisted transcript.
export function currentTestResponse(messages: TestMessage[], audience: TestMessage['audience']) {
  const own = messages.filter((message) => message.audience === audience);
  const turns = messages.flatMap((message) =>
    typeof message.turn === 'number' ? [message.turn] : [],
  );
  if (turns.length) {
    const latest = Math.max(...turns);
    return own.filter((message) => message.turn === latest);
  }
  // Sessions created before turn tracking are still usable. Keep only their last
  // response, or the consecutive dummy deliveries belonging to that response.
  const last = own.at(-1);
  if (!last) return [];
  if (!last.delivery) return [last];
  let start = own.length - 1;
  while (start > 0 && own[start - 1].delivery) start--;
  return own.slice(start);
}
