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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceImage, validateImageBytes } from '../image-file.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test('validateImageBytes rejects image signatures without parseable dimensions', () => {
  assert.throws(
    () => validateImageBytes(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')),
    /dimensions/i,
  );
});

test('validateImageBytes accepts a valid one-pixel image', () => {
  assert.deepEqual(validateImageBytes(ONE_PIXEL_PNG), {
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
  });
});

test('validateImageBytes rejects non-positive image dimensions', () => {
  const png = Buffer.from(ONE_PIXEL_PNG);
  png.writeUInt32BE(0, 16);

  assert.throws(() => validateImageBytes(png), /dimensions/i);
});

test('readWorkspaceImage rejects images whose dimensions exceed the model input limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-file-'));
  const path = join(root, 'oversized.png');
  const png = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(8001, 16);
  png.writeUInt32BE(8001, 20);
  png[24] = 8;
  png[25] = 6;
  await writeFile(path, png);

  try {
    await assert.rejects(readWorkspaceImage(path), /dimensions.*downscale/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
