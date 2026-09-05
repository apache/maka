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

import { resolveStorageRoot, StorageRootAuthorityError } from '../../root-authority.js';

const [root] = process.argv.slice(2);
if (!root || !process.send) throw new Error('usage: root-resolver <root>');

try {
  await resolveStorageRoot({ path: root, kind: 'interactive' });
  await send({ type: 'resolved' });
} catch (error) {
  await send({
    type: 'error',
    code: error instanceof StorageRootAuthorityError ? error.code : 'unexpected',
  });
}
process.disconnect?.();

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
