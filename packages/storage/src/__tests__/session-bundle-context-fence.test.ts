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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { createSessionStore } from '../session-store.js';
import { SqliteContextOffloadStore } from '../sqlite-context-offload-store.js';
import { runWithContextValueMutation } from '../context-value-mutation-gate.js';
import { importSessionBundleState } from '../session-bundle-policy.js';

function input(name: string): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
    name,
    labels: [],
  };
}

const LIMITS = {
  ownerMaxBytes: { read_image_snapshot: 4096, tool_result_archive: 4096 },
  sessionLogicalBytes: 1_000_000,
  workspacePhysicalBytes: 10_000_000,
};

async function seedSessionWithPayload(stateRoot: string, name: string): Promise<string> {
  const sessions = createSessionStore(stateRoot);
  let sessionId: string;
  try {
    sessionId = (await sessions.create(input(name))).id;
  } finally {
    await sessions.close?.();
  }
  // The real Store, not an approximation of it: the fence being tested is the
  // one the Store takes for its own publication and collection.
  const store = new SqliteContextOffloadStore(join(stateRoot, 'context-offload.sqlite'), {
    limits: LIMITS,
  });
  try {
    const put = await store.put({
      sessionId,
      owner: { kind: 'read_image_snapshot', ownerId: `shot-${name}` },
      bytes: new TextEncoder().encode(`payload-${name}`),
      mediaType: 'image/png',
    });
    assert.equal(put.ok, true);
  } finally {
    store.close();
  }
  return sessionId;
}

test('an import takes its turn in the target root context mutation queue', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-context-fence-'));
  const source = join(base, 'source');
  const target = join(base, 'target');
  try {
    const sessionId = await seedSessionWithPayload(source, 'Exported');
    await seedSessionWithPayload(target, 'Unrelated');

    // The Store's operations read database state, await, and only then act on
    // files -- collection decides a payload is unreferenced, awaits, unlinks
    // it. An import publishing inside that await leaves a reference pointing at
    // a file about to be removed, and the re-check collection performs cannot
    // see it because the check and the unlink straddle the await. Holding the
    // turn stands in for a Store operation in flight.
    const canonicalTarget = await realpath(target);
    let settle!: () => void;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const holding = runWithContextValueMutation(canonicalTarget, () => held);

    let finished = false;
    const importing = importSessionBundleState({
      stateRoot: target,
      bundleStateRoot: source,
    }).then((result) => {
      finished = true;
      return result;
    });

    // Long enough for an import that ignores the queue to have run to the end.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(finished, false, 'the import must wait for the turn in flight');

    settle();
    await holding;
    const imported = await importing;
    assert.deepEqual([...imported.sessionIds], [sessionId]);
    assert.equal(imported.contextRefs, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
