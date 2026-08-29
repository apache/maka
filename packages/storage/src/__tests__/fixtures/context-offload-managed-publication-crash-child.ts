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

import { join } from 'node:path';
import {
  CONTEXT_OFFLOAD_DATABASE_NAME,
  SqliteContextOffloadStore,
} from '../../sqlite-context-offload-store.js';

const root = process.env.MAKA_CONTEXT_OFFLOAD_CRASH_ROOT;
if (!root) throw new Error('Missing context-offload crash fixture root');

const store = new SqliteContextOffloadStore(join(root, CONTEXT_OFFLOAD_DATABASE_NAME), {
  limits: {
    ownerMaxBytes: {
      read_image_snapshot: 5 * 1024 * 1024,
      tool_result_archive: 8 * 1024 * 1024,
    },
    sessionLogicalBytes: 16 * 1024 * 1024,
    workspacePhysicalBytes: 32 * 1024 * 1024,
  },
  failpoint(point) {
    const requested = process.env.MAKA_CONTEXT_OFFLOAD_CRASH_POINT ?? 'after_managed_file_publish';
    if (point === requested) process.exit(73);
  },
});

await store.put({
  sessionId: 'session-1',
  owner: {
    kind: 'read_image_snapshot',
    ownerId: process.env.MAKA_CONTEXT_OFFLOAD_OWNER_ID ?? 'read-call-1',
  },
  bytes: new TextEncoder().encode(
    process.env.MAKA_CONTEXT_OFFLOAD_VALUE ?? 'crash-safe-managed-value',
  ),
  mediaType: 'image/png',
});
throw new Error('Managed-file publication crash failpoint was not reached');
