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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';

test('tells the model that a session image ref is a Markdown image source', () => {
  const event: RuntimeEvent = {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: {
      kind: 'text',
      text: 'show this',
      attachments: [
        {
          kind: 'image',
          name: 'preview.png',
          mimeType: 'image/png',
          bytes: 3,
          ref: {
            kind: 'session_file',
            sessionId: 'session-1',
            relativePath: 'attachment-123',
          },
        },
      ],
    },
  };

  const item = buildRuntimeEventModelReplayPlan([event]).items[0];
  assert.equal(item?.kind, 'text');
  assert.match(
    item.content,
    /Markdown image source: "maka:\/\/runtime\/attachments\/attachment-123"/,
  );
});
