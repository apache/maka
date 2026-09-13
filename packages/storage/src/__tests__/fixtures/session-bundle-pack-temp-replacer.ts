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

import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, resultPath] = process.argv.slice(2);
if (root === undefined || resultPath === undefined) process.exit(2);

process.stdout.write('ready\n');
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const name = readdirSync(root).find((candidate) =>
    candidate.includes('.maka-session-bundle-pack-'),
  );
  if (name === undefined) continue;
  const temporaryPath = join(root, name);
  const capturedPath = `${temporaryPath}.captured`;
  try {
    renameSync(temporaryPath, capturedPath);
    writeFileSync(temporaryPath, 'EVIL');
    writeFileSync(resultPath, JSON.stringify({ capturedPath, temporaryPath }));
    process.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
process.exit(3);
