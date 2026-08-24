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
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '../../root-authority.js';

const [root, access] = process.argv.slice(2);
if (!root || (access !== 'read' && access !== 'write')) {
  throw new Error('usage: root-lock-holder <root> <read|write>');
}

const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
const lock =
  access === 'write'
    ? await tryAcquireInteractiveRootOwner(capability)
    : await tryAcquireInteractiveRootReader(capability);

if (!lock) {
  process.send?.({ type: 'denied' });
  process.exit(2);
}

process.send?.({ type: 'locked' });
process.on('message', (message) => {
  if (message === 'close') {
    void lock.close().finally(() => process.exit(0));
    return;
  }
  if (message === 'throw') {
    throw new Error('intentional uncaught holder failure');
  }
  if (message === 'abort') {
    process.abort();
  }
  if (message === 'spawn-descendant') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = descendant.pid;
    if (pid === undefined) throw new Error('descendant did not receive a process id');
    descendant.unref();
    process.send?.({ type: 'descendant', pid }, () => process.exit(0));
  }
});

setInterval(() => undefined, 1_000).unref();
