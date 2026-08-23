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

import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Force-removes every control-endpoint directory a test run created for a
// rootId. Mirrors the naming in ../../control/endpoint.ts: current
// directories truncate the base64url root tag to 16 characters and encode
// their owner pid before the random suffix, directories from before #2133
// used the full tag, and the endpoint root resolves to os.tmpdir() with a
// /tmp fallback. Unlike the production startup sweep this ignores liveness,
// because callers run it after their hosts have exited.
export async function removePosixEndpointDirectories(rootId: string): Promise<void> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const tag = Buffer.from(rootId, 'hex').toString('base64url');
  const prefixes = [`m-${process.getuid()}-${tag.slice(0, 16)}-`, `m-${process.getuid()}-${tag}-`];
  const roots = [...new Set([tmpdir(), '/tmp'])];
  await Promise.all(
    roots.map(async (root) => {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory()) return;
          if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) return;
          await rm(join(root, entry.name), { recursive: true, force: true });
        }),
      );
    }),
  );
}
