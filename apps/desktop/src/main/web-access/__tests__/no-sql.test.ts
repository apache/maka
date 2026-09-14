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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('web-access and web-gateway sources do not import sqlite or SQL strings', async () => {
  // Resolve TypeScript sources from apps/desktop cwd (compiled tests live under dist/).
  const root = join(process.cwd(), 'src/main');
  const files = [
    'web-access/crypto.ts',
    'web-access/store.ts',
    'web-access/ipc-main.ts',
    'web-gateway/session.ts',
    'web-gateway/attach.ts',
  ];
  for (const rel of files) {
    const text = await readFile(join(root, rel), 'utf8');
    assert.doesNotMatch(text, /sqlite|better-sqlite|CREATE TABLE|SELECT .*FROM/i, rel);
  }
});
