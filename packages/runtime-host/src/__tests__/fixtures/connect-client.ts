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

import { connectOrSpawnRuntimeHostWithDependencies } from '../../client/connect-or-spawn.js';
import { launchDetachedRuntimeHostCandidate } from '../../client/launcher.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../../protocol/index.js';

const [rootPath] = process.argv.slice(2);
if (!rootPath) {
  throw new Error('usage: connect-client <root>');
}

const candidatePids: number[] = [];
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
      const launch = launchDetachedRuntimeHostCandidate({ ...input, idleGraceMs: 200 });
      return {
        spawned: launch.spawned.then((attempt) => {
          candidatePids.push(attempt.pid);
          return attempt;
        }),
      };
    },
  },
);
if (result.kind !== 'connected') {
  throw new Error(`connect-client failed to connect: ${result.kind}`);
}

process.send?.({
  type: 'connected',
  hostEpoch: result.connection.hostEpoch,
  candidatePids,
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void result.connection.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.on('message', (message) => {
  if (message === 'close') close();
});
process.once('disconnect', close);
