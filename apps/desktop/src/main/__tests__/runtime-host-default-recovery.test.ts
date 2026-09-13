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
import test from 'node:test';
import { createRuntimeHostDefaultRecovery } from '../runtime-host-default-recovery.js';

test('recovers an unavailable default Host without blocking other Hosts', async () => {
  let defaultProfileId = 'office';
  const prompts: string[] = [];
  let retries = 0;
  let resolveRecovered!: () => void;
  const recovered = new Promise<void>((resolve) => {
    resolveRecovered = resolve;
  });
  const recovery = createRuntimeHostDefaultRecovery({
    defaultProfileId: () => defaultProfileId,
    prompt: async (failure) => {
      prompts.push(failure.error.message);
      return prompts.length === 1 ? 'retry' : 'use_local';
    },
    retry: async () => {
      retries += 1;
      return new Error('still offline');
    },
    useLocal: async () => {
      defaultProfileId = 'local';
      resolveRecovered();
    },
    onError: (error) => assert.fail(error instanceof Error ? error : String(error)),
  });

  recovery.offer({
    profileId: 'background',
    profileName: 'Background',
    error: new Error('not the default'),
  });
  recovery.offer({
    profileId: 'office',
    profileName: 'Office',
    error: new Error('offline'),
  });
  await recovered;

  assert.equal(defaultProfileId, 'local');
  assert.equal(retries, 1);
  assert.deepEqual(prompts, ['offline', 'still offline']);
});
