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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DIRECTORY_DETECTION_MAX_PATHS,
  detectAttachmentDirectories,
  registerAttachmentDirectoryDetectionIpc,
} from '../attachment-directory-detection.js';

describe('attachment directory detection (#5279)', () => {
  it('reports only an existing directory as a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-attachment-directory-'));
    try {
      const file = join(root, 'notes.txt');
      await writeFile(file, 'notes', 'utf8');
      const result = await detectAttachmentDirectories([
        root,
        file,
        join(root, 'missing'),
        // Relative to the main process's cwd, which is a directory: still refused.
        '.',
        '',
        42,
      ]);
      assert.deepEqual(result, [true, false, false, false, false, false]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a request that is not a bounded list of paths', async () => {
    await assert.rejects(detectAttachmentDirectories('not-a-list'));
    await assert.rejects(
      detectAttachmentDirectories(
        Array.from({ length: DIRECTORY_DETECTION_MAX_PATHS + 1 }, () => tmpdir()),
      ),
    );
  });

  it('answers on the channel the preload invokes', async () => {
    const handlers = new Map<string, (event: unknown, paths: unknown) => Promise<boolean[]>>();
    registerAttachmentDirectoryDetectionIpc({
      ipcMain: {
        handle(channel, listener) {
          handlers.set(channel, listener);
        },
      },
    });
    const handler = handlers.get('attachments:detectDirectories');
    assert.ok(handler);
    assert.deepEqual(await handler({}, [tmpdir()]), [true]);
  });
});
