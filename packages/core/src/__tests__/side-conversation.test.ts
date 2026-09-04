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

  it('is idempotent when the boundary is already present', () => {
    const boundary = buildSideConversationUserMessageBoundary();
    const messages = applySideConversationUserMessageBoundary(
      [{ role: 'user', content: `${boundary}\n\nalready there` }],
      {
        inheritedPrefixLength: 0,
        labels: [SIDE_CONVERSATION_SESSION_LABEL],
      },
    );

    assert.equal(messages[0]?.content, `${boundary}\n\nalready there`);
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
});
