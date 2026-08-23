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

const [archivePath, archiveDigest, limitsJson, destinationRoot] = process.argv.slice(2);
if (
  archivePath === undefined ||
  archiveDigest === undefined ||
  limitsJson === undefined ||
  destinationRoot === undefined
) {
  process.exit(2);
}

const originalOpen = fs.promises.open.bind(fs.promises);
let targeted = false;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (targeted || !args[0].toString().endsWith('.owner.json')) return handle;
  targeted = true;
  const originalWrite = handle.write.bind(handle);
  handle.write = (async (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    if (position === null) return originalWrite(buffer, offset, length, position);
    await originalWrite(buffer, offset, Math.min(length, 1), position);
    process.stdout.write('binding-partial\n');
    return new Promise<never>(() => {});
  }) as typeof handle.write;
  return handle;
};
syncBuiltinESMExports();

const { createSessionBundleFileService } = await import('../../index.js');
// Keep the deliberately wedged top-level await alive until the parent delivers
// SIGKILL. Without a referenced handle, Node exits with code 13 as soon as the
// event loop is empty and races the crash-state assertions in the parent test.
const keepAlive = setInterval(() => undefined, 60_000);
try {
  await createSessionBundleFileService().hydrate({
    source: {
      path: archivePath,
      expectedArchiveDigest: archiveDigest as `sha256:${string}`,
    },
    limits: JSON.parse(limitsJson),
    expectedSessionId: 'cloud-session-1',
    destinationRoot,
  });
} finally {
  clearInterval(keepAlive);
}
