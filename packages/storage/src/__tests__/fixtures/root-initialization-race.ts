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

const [rootArgument, markerFile] = process.argv.slice(2);
if (!rootArgument || !markerFile || !process.send) {
  throw new Error('usage: root-initialization-race <root> <marker-file>');
}

const root = fs.realpathSync(rootArgument);
const markerTempPrefix = join(root, `${markerFile}.`);
const originalOpen = fs.promises.open;
let intercepted = false;

fs.promises.open = (async (path, flags, mode) => {
  if (
    !intercepted &&
    typeof path === 'string' &&
    path.startsWith(markerTempPrefix) &&
    path.endsWith('.tmp')
  ) {
    intercepted = true;
    await send({ type: 'marker_open_pending' });
    await waitForResume();
  }
  return originalOpen(path, flags, mode);
}) as typeof fs.promises.open;
syncBuiltinESMExports();

const { resolveStorageRoot, StorageRootAuthorityError } = await import('../../root-authority.js');

const parentDisconnected = new Promise<void>((resolvePromise) =>
  process.once('disconnect', resolvePromise),
);
try {
  await resolveStorageRoot({ path: root, kind: 'interactive' });
  await send({ type: 'resolved' });
} catch (error) {
  await send({
    type: 'error',
    code: error instanceof StorageRootAuthorityError ? error.code : 'unexpected',
  });
}
await parentDisconnected;

function waitForResume(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (message: unknown) => {
      if (message !== 'resume') return;
      cleanup();
      resolvePromise();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('parent disconnected before resuming marker initialization'));
    };
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function send(message: object): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
