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

import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function stapleMacosArtifact(
  path,
  { run = execute, wait = sleep, report = (text) => process.stderr.write(text) } = {},
) {
  const options = { encoding: 'utf8', timeout: 120_000 };
  for (const action of ['staple', 'validate']) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await run('xcrun', ['stapler', action, path], options);
        report(`${result.stdout ?? ''}${result.stderr ?? ''}`);
        break;
      } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        report(output);
        // Exit 68 also covers invalid tickets; retry only the observed transport failure.
        if (error.code !== 68 || !/NSURLErrorDomain Code=-1005\b/u.test(output) || attempt === 3) {
          throw error;
        }
        const delay = attempt * 10_000;
        report(
          `[stapler ${action}] ticket connection lost on attempt ${attempt}/3; retrying in ${delay}ms\n`,
        );
        await wait(delay);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: staple-macos-artifact.mjs <artifact>');
  await stapleMacosArtifact(process.argv[2]);
}
