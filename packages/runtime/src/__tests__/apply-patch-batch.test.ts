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
import { ToolOutcomeUnknownError } from '@maka/core/events';
import {
  ApplyPatchBatchOutcomeUnknownError,
  executeApplyPatchOperations,
} from '../apply-patch-batch.js';
import type { ApplyPatchOperation } from '../filesystem-executor.js';

const operations: readonly ApplyPatchOperation[] = [
  { type: 'delete_file', path: 'a.txt' },
  { type: 'delete_file', path: 'b.txt' },
  { type: 'delete_file', path: 'c.txt' },
];

describe('executeApplyPatchOperations', () => {
  it('returns the definitely committed prefix for an ordinary failure', async () => {
    const seen: string[] = [];
    const result = await executeApplyPatchOperations(operations, async (operation) => {
      seen.push(operation.path);
      if (operation.path === 'b.txt') throw new Error('broken');
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.applied, [{ type: 'delete_file', path: 'a.txt' }]);
    assert.deepEqual(seen, ['a.txt', 'b.txt']);
  });

  it('preserves outcome-unknown classification and uncertain-operation metadata', async () => {
    const seen: string[] = [];
    await assert.rejects(
      executeApplyPatchOperations(operations, async (operation) => {
        seen.push(operation.path);
        if (operation.path === 'b.txt') throw new ToolOutcomeUnknownError('unknown');
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolOutcomeUnknownError);
        assert.ok(error instanceof ApplyPatchBatchOutcomeUnknownError);
        assert.deepEqual(error.applied, [{ type: 'delete_file', path: 'a.txt' }]);
        assert.deepEqual(error.uncertain, { type: 'delete_file', path: 'b.txt' });
        return true;
      },
    );
    assert.deepEqual(seen, ['a.txt', 'b.txt']);
  });
});
