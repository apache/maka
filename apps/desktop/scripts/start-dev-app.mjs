#!/usr/bin/env node
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
  handleDevelopmentLaunchOutcome,
  startDevelopmentApp,
  waitForDevelopmentLaunchVerdict,
} from './dev-app-runtime.mjs';

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exitCode = code;
}

const app = await startDevelopmentApp({ argv: process.argv.slice(2) });

// Preparing the bundle happens before the launcher owns any long-lived
// resources. Once the handle exists, signals clean up only those resources;
// the detached TCC app remains independently owned.
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());

app.child.on('error', (error) => {
  console.error(`[dev-app] failed to start: ${error.message}`);
  void stop(1);
});
if (app.isMacosBundle) {
  // `open` exits at the LaunchServices handoff. The log follower keeps this
  // command alive, but Ctrl-C stops only launcher-owned resources; the detached
  // TCC app remains running until the user quits it.
  app.child.on('exit', (code) => {
    if (code) void stop(code);
  });
  const outcome = await waitForDevelopmentLaunchVerdict({
    stopped: () => stopping,
    resultFile: app.resultFile,
  });
  // All decisions live in handleDevelopmentLaunchOutcome (see dev.mjs for the
  // one-line coupling note); this is the only unobserved part.
  handleDevelopmentLaunchOutcome(outcome, {
    log: (m) => console.error('[dev-app]', m),
    exit: (code) => stop(code),
  });
} else {
  app.child.on('exit', (code, signal) => {
    if (!stopping) process.exitCode = signal ? 1 : (code ?? 0);
  });
}
