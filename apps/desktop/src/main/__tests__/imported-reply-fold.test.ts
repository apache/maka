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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createExternalSessionAdapterRegistry } from '@maka/storage/external-sessions';
import { materializeTurns } from '@maka/ui';
import { foldTimeline } from '@maka/ui/testing';

test('completed OpenCode text followed by reasoning stays outside the process disclosure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maka-imported-reply-'));
  try {
    const db = new DatabaseSync(join(home, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
          time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        INSERT INTO session VALUES ('session', '/tmp', 'Imported reply', 1, 3, NULL, NULL);
      `);
      const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
      message.run('user', 'session', 1, JSON.stringify({ role: 'user' }));
      message.run('reply', 'session', 2, JSON.stringify({ role: 'assistant', finish: 'stop', modelID: 'm' }));
      const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
      part.run('prompt', 'user', 'session', 1, JSON.stringify({ type: 'text', text: 'go' }));
      part.run('answer', 'reply', 'session', 2, JSON.stringify({ type: 'text', text: 'Visible final answer' }));
      part.run('reasoning', 'reply', 'session', 3, JSON.stringify({ type: 'reasoning', text: 'late reasoning' }));
    } finally {
      db.close();
    }
    const adapter = createExternalSessionAdapterRegistry({ opencode: { opencodeHome: home } }).require('opencode');
    const session = await adapter.readSession('session');
    const turns = materializeTurns(session.messages, 'en');
    assert.equal(turns.length, 1);
    const turn = turns[0]!;
    assert.equal(turn.status, 'completed');
    assert.deepEqual(turn.timeline.map((item) => item.kind), ['text', 'thinking']);
    const folded = foldTimeline(turn.timeline).entries;
    assert.deepEqual(folded.filter((item) => item.kind === 'text').map((item) => item.text), ['Visible final answer']);
    const process = folded.find((item) => item.kind === 'processing');
    assert.ok(process);
    assert.deepEqual(process.children.map((item) => item.kind), ['thinking']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
