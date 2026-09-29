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

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';

const [stateRoot, sessionId, requestId, phase] = process.argv.slice(2);
if (!stateRoot || !sessionId || !requestId || !['before-cas', 'after-cas'].includes(phase))
  throw new Error('Invalid checkpoint crash fixture input');
const originalRename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (...args) => {
  if (!args[1].toString().endsWith(join('repository', 'session-repository-v1.json')))
    return originalRename(...args);
  if (phase === 'after-cas') await originalRename(...args);
  process.send?.({ phase });
  await new Promise<never>(() => setInterval(() => {}, 1000));
};
syncBuiltinESMExports();
const owner = await tryAcquireInteractiveRootOwner(
  await resolveStorageRoot({ path: stateRoot, kind: 'interactive' }),
);
if (!owner) throw new Error('Could not acquire checkpoint test Host owner');
const composition = await createExecutionRuntimeHostComposition(
  {
    owner,
    hostEpoch: 'crash-host',
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => {},
    requestDrain: () => {},
  },
  { bootstrapRuntimePolicy: false },
  {
    checkpointPublication: {
      workspace: { runExclusive: async (_input, operation) => operation() },
      limits: {
        maxCompressedBytes: 8 * 1024 * 1024,
        maxDecompressedTarBytes: 16 * 1024 * 1024,
        maxPayloadBytes: 8 * 1024 * 1024,
        maxFileBytes: 8 * 1024 * 1024,
        maxEntryCount: 1000,
        maxManifestBytes: 256 * 1024,
        maxStateIdentityBytes: 64 * 1024,
        maxPathBytes: 255,
        maxPathDepth: 32,
      },
      privateStagingRootAuthority:
        process.platform === 'win32'
          ? {
              verifyPrivateStagingRoot: async ({ canonicalPath }) => ({ canonicalPath }),
            }
          : undefined,
    },
  },
);
await composition.recover();
await composition.sessionCheckpoints.publish({ sessionId, requestId });
throw new Error('Checkpoint publication passed its crash point');
