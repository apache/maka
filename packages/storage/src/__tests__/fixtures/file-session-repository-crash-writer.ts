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

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { CommitSessionRevisionInput } from '../../session-repository.js';

const [root, inputPath, crashPoint] = process.argv.slice(2);
if (!root || !inputPath || !['before-rename', 'after-rename'].includes(crashPoint)) {
  throw new Error('Expected repository root, commit input and crash point');
}
const statePath = join(root, 'session-repository-v1.json');
const originalRename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (...args) => {
  if (args[1].toString() !== statePath) return originalRename(...args);
  if (crashPoint === 'after-rename') await originalRename(...args);
  // Pause a real public commit while its repository lock is held, without
  // adding a production fault-injection API or running the holder's finally.
  process.send?.(crashPoint);
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
};
syncBuiltinESMExports();

const { openFileSessionRepository } = await import('../../file-session-repository.js');
const input = JSON.parse(
  await fs.promises.readFile(inputPath, 'utf8'),
) as CommitSessionRevisionInput;
await (await openFileSessionRepository({ storageRoot: root })).commit(input);
throw new Error('Repository commit unexpectedly passed its crash point');
