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

import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stableJsonStringify } from '@maka/core/canonical-json';
import { FileAttemptStore } from './attempt-store.js';
import type { ExperimentSpec } from './experiment.js';
import { parseExperimentSpec } from './spec.js';

export async function openExperimentDirectory(root: string, spec: ExperimentSpec) {
  await mkdir(root, { recursive: true });
  const specPath = join(root, 'experiment.json');
  const temporaryPath = join(root, `.experiment-${randomUUID()}.tmp`);
  const canonical = `${stableJsonStringify(spec)}\n`;
  const temporary = await open(temporaryPath, 'wx', 0o600);
  try {
    await temporary.writeFile(canonical);
    await temporary.sync();
    await temporary.close();
    await link(temporaryPath, specPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')));
    if (stableJsonStringify(existing) !== stableJsonStringify(spec)) {
      throw new Error('experiment spec differs');
    }
  } finally {
    await temporary.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { root, specPath, attempts: new FileAttemptStore(join(root, 'attempts')) };
}
