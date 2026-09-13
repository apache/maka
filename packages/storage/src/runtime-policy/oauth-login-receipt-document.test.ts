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
import { test } from 'node:test';
import {
  findInteractiveOAuthLoginReceipt,
  MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS,
  readInteractiveOAuthLoginReceipts,
  upsertInteractiveOAuthLoginReceipt,
} from './oauth-login-receipt-document.js';

test('OAuth receipt retention has one explicit 256-attempt idempotency window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-receipts-'));
  try {
    for (let index = 0; index <= MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS; index += 1) {
      await upsertInteractiveOAuthLoginReceipt(root, receipt(index));
    }
    const retained = await readInteractiveOAuthLoginReceipts(root);
    assert.equal(retained.receipts.length, MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS);
    assert.equal(findInteractiveOAuthLoginReceipt(retained, 'attempt-0'), undefined);
    assert.equal(findInteractiveOAuthLoginReceipt(retained, 'attempt-1')?.completionOrder, 2);
    assert.equal(
      findInteractiveOAuthLoginReceipt(retained, `attempt-${MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS}`)
        ?.completionOrder,
      MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS + 1,
    );

    // Eviction intentionally ends the old idempotency claim: the same key can
    // name a later attempt and receives a new completion order.
    const reused = await upsertInteractiveOAuthLoginReceipt(root, receipt(0));
    assert.equal(reused.completionOrder, MAX_INTERACTIVE_OAUTH_LOGIN_RECEIPTS + 2);
    assert.equal(
      findInteractiveOAuthLoginReceipt(await readInteractiveOAuthLoginReceipts(root), 'attempt-0')
        ?.completionOrder,
      reused.completionOrder,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a retained OAuth attempt cannot be rebound to another target or entity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-receipts-'));
  try {
    const original = await upsertInteractiveOAuthLoginReceipt(root, receipt(7));
    assert.deepEqual(await upsertInteractiveOAuthLoginReceipt(root, receipt(7)), original);
    await assert.rejects(
      upsertInteractiveOAuthLoginReceipt(root, {
        ...receipt(7),
        target: { kind: 'create', providerType: 'xai-oauth' },
        connection: {
          ...receipt(7).connection,
          slug: 'xai-oauth',
          providerType: 'xai-oauth',
        },
      }),
      /receipt conflicts/u,
    );
    await assert.rejects(
      upsertInteractiveOAuthLoginReceipt(root, {
        ...receipt(7),
        connection: { ...receipt(8).connection },
      }),
      /receipt conflicts/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function receipt(index: number) {
  return {
    attemptId: `attempt-${index}`,
    target: { kind: 'create' as const, providerType: 'openai-codex' as const },
    connection: {
      connectionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      slug: index === 0 ? 'codex-subscription' : `codex-subscription-${index + 1}`,
      providerType: 'openai-codex' as const,
    },
  };
}
