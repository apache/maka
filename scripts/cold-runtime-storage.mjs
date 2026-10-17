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

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '../packages/storage/dist/root-authority.js';
import {
  ColdRuntimeStorage,
  reclaimColdRuntimeStorageSpace,
} from '../packages/storage/dist/cold-runtime-storage.js';
import { TranscriptStorageWorker } from '../packages/runtime-host/dist/server/transcript-storage-worker-client.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, 'max-batches': { type: 'string', default: '1000' } },
});
const command = positionals[0];
const maxBatches = Number(values['max-batches']);
if (
  !values.root ||
  positionals.length !== 1 ||
  !['inspect', 'enable', 'disable', 'compress', 'restore', 'reclaim', 'convert'].includes(
    command,
  ) ||
  !Number.isSafeInteger(maxBatches) ||
  maxBatches < 1
) {
  throw new Error(
    'Usage: node scripts/cold-runtime-storage.mjs inspect|enable|disable|compress|restore|reclaim|convert --root PATH [--max-batches 1000]',
  );
}
const capability = await resolveStorageRoot({ path: values.root, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner)
  throw new Error(
    'Storage root is in use. Stop its Runtime Host before running offline maintenance.',
  );
let cold;
let worker;
try {
  if (command === 'reclaim' || command === 'convert') {
    const result = await reclaimColdRuntimeStorageSpace(owner.lease, {
      enableIncrementalVacuum: command === 'convert',
    });
    console.log(JSON.stringify(result));
    if (result.busy) process.exitCode = 1;
  } else {
    worker = new TranscriptStorageWorker({
      databasePath: join(capability.canonicalPath, 'runtime.sqlite'),
      permissions: async () => new Map(),
    });
    cold = await ColdRuntimeStorage.open({
      lease: owner.lease,
      codec: worker.codec,
      canRun: () => true,
      isProtected: () => false,
    });
    if (command === 'enable' || command === 'disable') await cold.setEnabled(command === 'enable');
    let work;
    if (command === 'compress' || command === 'restore') {
      if (command === 'compress' && !(await cold.inspect()).writerEnabled)
        throw new Error('Compression writer is disabled; explicitly enable it before compressing.');
      work = { batches: 0, changed: 0, inputBytes: 0, failures: 0, hasMore: false, busy: false };
      do {
        const result =
          command === 'restore' ? await cold.restoreBatch() : await cold.compressBatch();
        work.batches += 1;
        work.changed += result.changed;
        work.inputBytes += result.inputBytes;
        work.failures += result.failures;
        work.hasMore = result.hasMore;
        work.busy = result.busy;
        work.pauseReason = result.pauseReason;
      } while (work.hasMore && !work.busy && work.batches < maxBatches);
    }
    console.log(JSON.stringify({ ...(work && { work }), storage: await cold.inspect() }));
    if (work?.failures || work?.busy || work?.hasMore || work?.pauseReason) process.exitCode = 1;
  }
} finally {
  await worker?.close();
  cold?.close();
  await owner.close();
}
