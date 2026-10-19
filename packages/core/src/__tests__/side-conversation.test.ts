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
import { describe, it } from 'node:test';
import {
  applySideConversationReplayItemBoundary,
  applySideConversationUserMessageBoundary,
  buildSideConversationUserMessageBoundary,
  resolveSideConversationPromptCacheSessionId,
  SIDE_CONVERSATION_SESSION_LABEL,
  userContentIncludesSideConversationBoundary,
} from '../side-conversation.js';

describe('side-conversation prompt cache helpers', () => {
  it('prepends the boundary to the first fork-owned user message', () => {
    const messages = applySideConversationUserMessageBoundary(
      [
        { role: 'assistant', content: 'parent reply' },
        { role: 'user', content: 'side question' },
      ],
      {
        inheritedPrefixLength: 1,
        labels: [SIDE_CONVERSATION_SESSION_LABEL],
      },
    );

    assert.equal(messages[0]?.role, 'assistant');
    assert.equal(messages[1]?.role, 'user');
    assert.match(String(messages[1]?.content), /Side conversation boundary:/);
    assert.match(String(messages[1]?.content), /side question/);
  });

  it('still prefixes the real boundary when a fork first message itself mentions the marker', () => {
    // #4543 review P3: whether the boundary is applied must be decided
    // structurally (first user message after the inherited prefix), never by
    // searching user-controlled text for the marker. A message that quotes the
    // marker must not suppress the real boundary.
    const messages = applySideConversationUserMessageBoundary(
      [{ role: 'user', content: 'What does "Side conversation boundary:" mean?' }],
      {
        inheritedPrefixLength: 0,
        labels: [SIDE_CONVERSATION_SESSION_LABEL],
      },
    );

    assert.match(
      String(messages[0]?.content),
      new RegExp(`^${buildSideConversationUserMessageBoundary()}\n\n`),
    );
    assert.match(String(messages[0]?.content), /What does "Side conversation boundary:" mean\?/);
  });

  it('routes OpenAI prompt cache keys through the parent session id', () => {
    assert.equal(
      resolveSideConversationPromptCacheSessionId({
        sessionId: 'fork-session',
        parentSessionId: 'parent-session',
        labels: [SIDE_CONVERSATION_SESSION_LABEL],
      }),
      'parent-session',
    );
    assert.equal(
      resolveSideConversationPromptCacheSessionId({
        sessionId: 'main-session',
        labels: [],
      }),
      'main-session',
    );
  });

  it('detects an existing boundary marker in multipart user content', () => {
    assert.equal(
      userContentIncludesSideConversationBoundary([
        { type: 'text', text: 'Side conversation boundary:\nhello' },
      ]),
      true,
    );
  });

  it('prefixes the boundary onto exactly the owning replay item, structurally', () => {
    const boundary = buildSideConversationUserMessageBoundary();
    const items = [
      {
        kind: 'text' as const,
        role: 'user' as const,
        content: 'inherited parent question',
        eventId: 'inherited-user',
      },
      {
        kind: 'text' as const,
        role: 'user' as const,
        content: 'fork question mentioning Side conversation boundary: inline',
        eventId: 'fork-user-1',
      },
    ];
    const once = applySideConversationReplayItemBoundary(items, {
      boundaryEventId: 'fork-user-1',
      labels: [SIDE_CONVERSATION_SESSION_LABEL],
    });
    assert.match(String(once[0]?.content), /^inherited parent question$/);
    assert.match(String(once[1]?.content), new RegExp(`^${boundary}\n\n`));
    assert.match(
      String(once[1]?.content),
      /fork question mentioning Side conversation boundary: inline/,
    );
  });
});
