/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
