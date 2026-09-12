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

import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createSqliteArtifactStoreWriteAuthority } from '../../artifact-store.js';

const [root, phase, target] = process.argv.slice(2);
if (!root || !target || !process.send) throw new Error('Expected root, phase, target and IPC');
async function crashPoint() {
  await new Promise<void>((resolve, reject) =>
    process.send!(phase, (error) => (error ? reject(error) : resolve())),
  );
  // The parent kills this process while the IPC channel keeps it alive.
  await new Promise<void>(() => {});
}
if (phase === 'after-unlink') {
  const originalRm = fs.rm;
  fs.rm = async (...args: Parameters<typeof originalRm>) => {
    await originalRm(...args);
    if (args[0] === target) await crashPoint();
  };
  syncBuiltinESMExports();
}
const authority = createSqliteArtifactStoreWriteAuthority(root);
try {
  const results = await authority.store.purgeSessionArtifactsBatch(['a', 'b']);
  for (const result of results.values()) if (result.status === 'rejected') throw result.reason;
  if (phase !== 'after-metadata') throw new Error('Missed unlink crash point');
  await crashPoint();
} finally {
  authority.close();
}
