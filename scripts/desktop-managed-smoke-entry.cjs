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
// Test launcher only: use the real app, not MAKA_E2E's FakeBackend.
const { app } = require('electron');
const { join, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.env.MAKA_MANAGED_SMOKE_ROOT;
if (!root || !isAbsolute(root) || app.isPackaged) throw new Error('Isolated smoke root required');
const desktop = join(__dirname, '..', 'apps', 'desktop');
app.setAppPath(desktop);
app.setPath('userData', join(root, 'user-data'));
process.chdir(desktop);
// Test launcher only. The product launcher and Host do not expose this switch.
if (process.env.MAKA_MANAGED_SMOKE_DEBUG_HOST === '1') {
  const childProcess = require('node:child_process');
  const { syncBuiltinESMExports } = require('node:module');
  const { writeFileSync, renameSync } = require('node:fs');
  const spawn = childProcess.spawn;
  childProcess.spawn = function (executable, args, options) {
    const isHost =
      Array.isArray(args) &&
      args.includes('--expected-root-id') &&
      args.includes(join(root, 'user-data', 'workspaces', 'default'));
    const child = spawn.call(
      this,
      executable,
      isHost ? ['--inspect=127.0.0.1:0', ...args] : args,
      options,
    );
    if (isHost) {
      let output = '';
      let published = false;
      child.stderr?.on('data', (chunk) => {
        if (published) return;
        output = (output + chunk.toString()).slice(-8192);
        const endpoint = output.match(
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
        )?.[1];
        if (endpoint) {
          writeFileSync(
            join(root, 'host-debugger.tmp'),
            JSON.stringify({ pid: child.pid, endpoint }),
          );
          renameSync(join(root, 'host-debugger.tmp'), join(root, 'host-debugger.json'));
          published = true;
        }
      });
    }
    return child;
  };
  syncBuiltinESMExports();
}
import(pathToFileURL(join(desktop, 'dist/main/main.js')).href).catch((error) => {
  console.error(error);
  app.exit(1);
});
