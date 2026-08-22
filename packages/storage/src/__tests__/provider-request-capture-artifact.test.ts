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

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteArtifactStore as createArtifactStore } from '../artifact-store.js';
import * as storage from '../index.js';

test('persists the exact prepared request as a private artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-capture-'));
  const store = createArtifactStore(root);
  const persist = Reflect.get(storage, 'persistProviderRequestCaptureArtifact') as unknown as
    | ((
        store: ReturnType<typeof createArtifactStore>,
        input: Record<string, unknown>,
      ) => Promise<{ id: string; source?: string; sizeBytes: number }>)
    | undefined;
  assert.equal(typeof persist, 'function');
  const serializedRequest = '{"messages":[{"role":"user","content":"exact"}]}';

  const artifact = await persist!(store, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    captureId: 'capture-1',
    step: 2,
    serializedRequest,
    now: 1,
  });

  assert.equal(artifact.source, 'provider_request_capture');
  assert.equal(artifact.sizeBytes, Buffer.byteLength(serializedRequest));
  assert.deepEqual(await store.readText(artifact.id), { ok: true, text: serializedRequest });
});
