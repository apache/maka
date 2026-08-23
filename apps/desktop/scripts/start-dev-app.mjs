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

import { monitorDevelopmentApp, startDevelopmentApp } from './dev-app-runtime.mjs';

let app = null;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await app?.stop();
  process.exitCode = code;
}

// Registered before any await. Preparing the bundle and monitoring the app both
// suspend this module for a long time, and a signal arriving while no handler
// is installed takes the default action — killing this process mid-teardown and
// orphaning the app it was supposed to stop.
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());

app = await startDevelopmentApp({ argv: process.argv.slice(2) });

app.child.on('error', (error) => {
  console.error(`[dev-app] failed to start: ${error.message}`);
  void stop(1);
});
if (app.isMacosBundle) {
  // `open` exits 0 at the LaunchServices handoff, so this process would end
  // immediately and leave nothing to stop the app on Ctrl-C. Monitoring the
  // detached app is both what keeps it alive and what reports the app quitting.
  app.child.on('exit', (code) => {
    if (code) void stop(code);
  });
  const outcome = await monitorDevelopmentApp({ stopped: () => stopping });
  if (outcome === 'never-started') {
    console.error('[dev-app] Maka Dev.app did not start (see the output above)');
    void stop(1);
  } else if (outcome === 'exited') {
    void stop(0);
  }
} else {
  app.child.on('exit', (code, signal) => {
    if (!stopping) process.exitCode = signal ? 1 : (code ?? 0);
  });
}
