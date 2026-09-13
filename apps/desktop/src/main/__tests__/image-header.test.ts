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
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { readImageHeader } from '../image-header.js';

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    deflateSync(Buffer.alloc(64)),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  // A comment segment first, so the scan has to walk past something.
  const comment = Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x41, 0x42]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, sof]);
}

test('dimensions come out of the bytes, for both offered formats', () => {
  assert.deepEqual(readImageHeader(png(1024, 512)), {
    format: 'png',
    width: 1024,
    height: 512,
  });
  assert.deepEqual(readImageHeader(jpeg(640, 480)), {
    format: 'jpeg',
    width: 640,
    height: 480,
  });
});

/**
 * The point of reading the header first: a small file can declare an enormous
 * bitmap, and that has to be visible before a decoder allocates it.
 */
test('a small file declaring a huge bitmap reports the huge dimensions', () => {
  const bomb = png(30000, 30000);
  assert.ok(bomb.length < 1024, 'the fixture must stay small to make the point');
  assert.deepEqual(readImageHeader(bomb), { format: 'png', width: 30000, height: 30000 });
});

test('anything that is not PNG or JPEG is not recognised', () => {
  for (const bytes of [
    Buffer.from('RIFF____WEBPVP8 ', 'latin1'), // WebP
    Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), // TIFF
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'latin1'),
    Buffer.alloc(0),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]), // truncated PNG signature
  ]) {
    assert.equal(readImageHeader(bytes), undefined);
  }
});

test('a JPEG whose markers run out is not guessed at', () => {
  assert.equal(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x20])), undefined);
});
