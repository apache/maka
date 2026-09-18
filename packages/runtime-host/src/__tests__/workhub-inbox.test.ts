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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkHubInbox } from '../server/workhub-inbox.js';
test('inbox persists frozen requests and source receipts across restart, including uncertain native admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workhub-inbox-'));
  try {
    const path = join(root, 'inbox.sqlite'),
      first = new WorkHubInbox(path);
    const input = { text: 'request' };
    await first.receive({
      id: 'one',
      input,
      content: { text: 'request with original evidence', workhubSource: 'voice_request' },
    });
    await first.failed('one', 'native receipt unavailable');
    const second = new WorkHubInbox(path);
    await second.receive({ id: 'one', input, content: { text: 'different live evidence' } });
    assert.equal((await second.pending())[0]!.content.text, 'request with original evidence');
    await assert.rejects(
      second.receive({ id: 'one', input: { text: 'different' }, content: { text: 'different' } }),
      /identity/,
    );
    await second.delivered('one', { turnId: 'native-root' });
    const third = new WorkHubInbox(path);
    assert.deepEqual(await third.pending(), []);
    assert.deepEqual((await third.read('one'))!.receipt, { turnId: 'native-root' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
