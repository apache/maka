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

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import {
  withLegacyFileUpdateLockLease,
  withProcessLifetimeFileUpdateLock,
} from '../../process-lifetime-file-update-lock.js';

const targetPath = process.argv[2];
if (!targetPath) throw new Error('Missing file update lock target');

const hold = async () => {
  process.send?.('locked');
  await new Promise<never>(() => setInterval(() => undefined, 1_000));
};

if (process.argv[3] === 'legacy') {
  await withLegacyFileUpdateLockLease(targetPath, async (inheritedFd) => {
    if (inheritedFd <= 2) throw new Error('Legacy lock lease is not inheritable');
    await mkdir(`${targetPath}.lock`);
    await hold();
  });
} else if (process.argv[3] === 'inherit') {
  await withProcessLifetimeFileUpdateLock(targetPath, async (inheritedFd) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      stdio: ['ignore', 'ignore', 'inherit', inheritedFd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    process.send?.({ kind: 'locked', inheritorPid: child.pid });
    await new Promise<never>(() => setInterval(() => undefined, 1_000));
  });
} else {
  await withProcessLifetimeFileUpdateLock(targetPath, hold);
}
