import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeChatConversationItems } from '../chat-conversation-items.js';

test('places resident items with their turns and bounds an explicit orphan', () => {
  const placed = placeChatConversationItems([
    { afterTurnId: 'old', value: 'historical' },
    { afterTurnId: 'resident', value: 'anchored' },
    { afterTurnId: 'missing-a', renderWhenAnchorMissing: true, value: 'stale-pending' },
    { afterTurnId: 'missing-b', renderWhenAnchorMissing: true, value: 'latest-pending' },
  ], new Set(['resident']));

  assert.deepEqual(placed.byTurn.get('resident'), ['anchored']);
  assert.equal(placed.byTurn.has('old'), false);
  assert.equal(placed.orphan, 'latest-pending');
});
