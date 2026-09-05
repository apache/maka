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
  launchDetachedRuntimeHostCandidate,
  launchOwnedRuntimeHostCandidate,
  type DetachedCandidateInput,
} from '../../client/launcher.js';

const [rootPath, expectedRootId, mode] = process.argv.slice(2);
if (!rootPath || !expectedRootId) {
  throw new Error('usage: detached-launcher <root> <expected-root-id>');
}
const closeOnLauncherExit = mode === 'close-on-launcher-exit';
const stderrMarkerPath = closeOnLauncherExit ? undefined : mode;
const candidateEntrypoint = closeOnLauncherExit
  ? new URL('../../execution-candidate-main.js', import.meta.url)
  : new URL(
      stderrMarkerPath ? './stderr-after-launcher-exit.js' : './kernel-candidate.js',
      import.meta.url,
    );

const launchInput = {
  rootPath,
  expectedRootId,
  entrypoint: candidateEntrypoint,
  idleGraceMs: 10_000,
  ...(closeOnLauncherExit ? { closeOnLauncherExit: true } : {}),
  ...(stderrMarkerPath
    ? { env: { MAKA_TEST_STDERR_AFTER_PARENT_EXIT_MARKER: stderrMarkerPath } }
    : {}),
} satisfies DetachedCandidateInput;
const launch = closeOnLauncherExit
  ? launchOwnedRuntimeHostCandidate(launchInput)
  : launchDetachedRuntimeHostCandidate(launchInput);
const attempt = await launch.spawned;
process.send?.({ type: 'launched', pid: attempt.pid });
