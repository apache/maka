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

import { reapStaleRootControlDirectories } from '../../root-authority.js';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Fault injection after the real rename, before the quarantiner releases locks.
const pauseSource = process.argv[2];
if (pauseSource) {
  const originalRename = filesystem.rename;
  filesystem.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (source === pauseSource) {
      process.send?.({ type: 'quarantined', destination });
      await new Promise<void>(() => {
        setInterval(() => undefined, 1_000);
      });
    }
  };
  syncBuiltinESMExports();
}

const summary = await reapStaleRootControlDirectories({
  graceMs: 0,
  maxEntries: 100_000,
  maxDurationMs: 5_000,
});
process.send?.(summary);
