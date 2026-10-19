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
import { writeFile } from 'node:fs/promises';
import { HostPluginDataRuntime } from '../../server/plugin-data-runtime.js';

// Keep the IPC channel alive while the lease callback is deliberately suspended.
process.on('message', () => undefined);

await new HostPluginDataRuntime(process.argv[2]!).withScratchDirectory(
  { extensionId: 'fixture.extension', scopeId: 'session:test' },
  'catalog',
  new AbortController().signal,
  async (path) => {
    await writeFile(join(path, 'owned'), 'synthetic');
    process.send!({ path });
    await new Promise<void>(() => {
      /* Parent terminates this lock owner. */
    });
  },
);
