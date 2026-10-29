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
import { createInterface } from 'node:readline';

export async function cargoBuild(args, { cwd, env }) {
  const child = spawn('cargo', [...args, '--message-format=json'], {
    cwd,
    env,
    stdio: ['inherit', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const completed = new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal }));
  });
  const executables = new Map();
  try {
    const [result] = await Promise.all([
      completed,
      (async () => {
        for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          const message = JSON.parse(line);
          if (message.reason === 'compiler-message' && message.message.rendered)
            process.stderr.write(message.message.rendered);
          if (
            message.reason === 'compiler-artifact' &&
            message.target.kind.includes('bin') &&
            message.executable
          )
            executables.set(message.target.name, resolve(cwd, message.executable));
        }
      })(),
    ]);
    return { ...result, executables };
  } catch (error) {
    child.kill();
    throw error;
  }
}
