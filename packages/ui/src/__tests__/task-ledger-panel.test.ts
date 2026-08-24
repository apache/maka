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
import { describe, test } from 'node:test';
import type { Task } from '@maka/core/task-ledger';
import { deriveTaskLedgerPanelModel } from '../task-ledger-panel.js';

function task(input: Partial<Task> & Pick<Task, 'id' | 'key' | 'status'>): Task {
  return {
    subject: input.id,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

describe('task ledger panel model', () => {
  test('keeps terminal ancestors around active descendants', () => {
    const parent = task({ id: 'parent', key: 'T1', status: 'failed', failureReason: 'failed' });
    const child = task({ id: 'child', key: 'T1.1', parentId: parent.id, status: 'pending' });
    const model = deriveTaskLedgerPanelModel([parent, child]);
    assert.equal(model.activeCount, 1);
    assert.deepEqual(model.activeTree.map((item) => item.key), ['T1', 'T1.1']);
  });

  test('selects three recent terminal seeds and adds their ancestors without changing the count', () => {
    const root = task({ id: 'root', key: 'T1', status: 'in_progress' });
    const completedChild = task({
      id: 'child', key: 'T1.1', parentId: root.id, status: 'completed',
      completionEvidence: 'done', endedAt: 5,
    });
    const terminals = [2, 3, 4].map((index) => task({
      id: `terminal-${index}`,
      key: `T${index}`,
      status: 'cancelled',
      endedAt: index,
    }));
    const model = deriveTaskLedgerPanelModel([root, completedChild, ...terminals]);
    assert.equal(model.recentTerminalCount, 3);
    assert.deepEqual(model.recentTerminalTree.map((item) => item.key), ['T1', 'T1.1', 'T3', 'T4']);
  });
});
