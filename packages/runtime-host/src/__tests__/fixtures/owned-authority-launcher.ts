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

const [rootPath, expectedRootId, leasePath] = process.argv.slice(2);
if (!rootPath || !expectedRootId || !leasePath) {
  throw new Error('usage: owned-authority-launcher <root> <expected-root-id> <lease-path>');
}

const leaseFd = openSync(leasePath, 'a+');
const attempt = await launchOwnedRuntimeHostCandidate({
  rootPath,
  expectedRootId,
  entrypoint: new URL('../../execution-candidate-main.js', import.meta.url),
  idleGraceMs: 10_000,
  inheritableAuthorityLeaseFd: leaseFd,
}).spawned;
process.send?.({ type: 'launched', pid: attempt.pid });
await new Promise(() => undefined);
