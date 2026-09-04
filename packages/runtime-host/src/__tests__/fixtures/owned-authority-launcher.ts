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

import { openSync } from 'node:fs';
import { launchOwnedRuntimeHostCandidate } from '../../client/launcher.js';

const [rootPath, expectedRootId, leasePath, clientInstanceId] = process.argv.slice(2);
if (!rootPath || !expectedRootId || !leasePath || !clientInstanceId) {
  throw new Error(
    'usage: owned-authority-launcher <root> <expected-root-id> <lease-path> <client-id>',
  );
}

const leaseFd = openSync(leasePath, 'a+');
const attempt = await launchOwnedRuntimeHostCandidate({
  rootPath,
  expectedRootId,
  entrypoint: new URL('../../execution-candidate-main.js', import.meta.url),
  // The idle grace only has to outlast the test, and it has to stay clear of
  // any bound a test puts on an owner-loss exit: a Candidate that exits
  // because it went idle must never be mistaken for one that exited because
  // its launch owner died. The first-connection deadline stays short so a
  // Candidate no Client ever reaches still exits on its own.
  idleGraceMs: 60_000,
  initialConnectionTimeoutMs: 10_000,
  inheritableAuthorityLeaseFd: leaseFd,
  launchOwnerClientInstanceId: clientInstanceId,
}).spawned;
process.send?.({ type: 'launched', pid: attempt.pid });
process.on('message', (message) => {
  if (message === 'release') attempt.releaseToEnvironment();
});
await new Promise(() => undefined);
