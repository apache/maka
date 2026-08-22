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

import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { connectOrSpawnRuntimeHostWithDependencies } from '../../client/connect-or-spawn.js';
import { launchDetachedRuntimeHostCandidate } from '../../client/launcher.js';
import { readHostRegistration } from '../../control/registration.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../../protocol/index.js';

const [rootPath, mode] = process.argv.slice(2);
if (!rootPath) throw new Error('usage: electron-connect-parent <root>');
if (!process.versions.electron)
  throw new Error('electron-connect-parent requires Electron Node mode');
const candidateEntrypoint = new URL('./kernel-candidate.js', import.meta.url);

const result = await connectOrSpawnRuntimeHostWithDependencies(
  {
    rootPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint,
    electionDeadlineMs: 5_000,
  },
  {
    random: Math.random,
    launchCandidate: (input) => {
      const launch = launchDetachedRuntimeHostCandidate(input);
      return {
        spawned: launch.spawned.then(async (attempt) => {
          await sendToParent({ type: 'electron-candidate-launched', pid: attempt.pid });
          if (mode === 'exit-after-candidate-launch') process.exit(23);
          return attempt;
        }),
      };
    },
  },
);
if (result.kind !== 'connected') {
  throw new Error(`Electron Client failed to connect: ${result.kind}`);
}

const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
const registration = await readHostRegistration(controlDirectory);
if (!registration || registration.hostEpoch !== result.connection.hostEpoch) {
  throw new Error('Electron Client did not discover the Host it launched');
}
await result.connection.close();
await sendToParent({
  type: 'electron-parent-launched',
  hostEpoch: registration.hostEpoch,
  pid: registration.pid,
});
process.disconnect?.();

function sendToParent(message: unknown): Promise<void> {
  if (!process.send)
    return Promise.reject(new Error('electron-connect-parent requires an IPC parent'));
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
