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

import { runProcessWithBoundedTail } from '../../shell-exec.js';
import { PipeProcessDriver } from '../../pipe-process-driver.js';
const [mode, directory, script] = process.argv.slice(2) as [string, string, string];
if (mode === 'bounded') {
  const controller = new AbortController();
  process.on('message', () => controller.abort());
  const result = await runProcessWithBoundedTail(process.execPath, [script], {
    cwd: directory,
    timeoutMs: 30_000,
    killGraceMs: 5000,
    abortSignal: controller.signal,
  });
  process.send?.(result);
  process.disconnect?.();
} else if (mode === 'wrapped') {
  // A shell root whose child runs the script, as `sh -c` or `cmd /c` commands do.
  const [program, args]: [string, string[]] =
    process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', process.execPath, script]]
      : ['/bin/sh', ['-c', '"$0" "$1"; exit $?', process.execPath, script]];
  await runProcessWithBoundedTail(program, args, { cwd: directory, timeoutMs: 30_000 });
} else {
  const driver = new PipeProcessDriver({
    plan: { file: process.execPath, args: [script], useShellOption: false },
    cwd: directory,
    outputDrainMs: 100,
    onData: () => {},
    onRootExit: () => {},
    onExit: () => {},
    onFailure: (error) => {
      throw error;
    },
  });
  process.on('message', () => driver.kill('SIGTERM'));
  await driver.ready;
}
