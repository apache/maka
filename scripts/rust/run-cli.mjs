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

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileCli } from './build-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Select development build capabilities before Cargo resolves native dependencies. */
export async function runCli(
  argv,
  { env = process.env, platform = process.platform, osRelease, repositoryRoot = root } = {},
) {
  const build = await compileCli({
    env,
    platform,
    osRelease,
    repositoryRoot,
    desktop: argv.includes('desktop'),
  });
  if (build.code !== 0 || build.signal) return { code: build.code, signal: build.signal };
  return await new Promise((resolveRun, reject) => {
    const child = spawn(build.binary, argv, {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { code, signal } = await runCli(process.argv.slice(2));
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
