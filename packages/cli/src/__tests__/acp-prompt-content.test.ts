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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { mapAcpPromptContent } from '../acp/prompt-content.js';

describe('ACP prompt content', () => {
  test('joins ordered text blocks with paragraph separators', async () => {
    assert.deepEqual(
      await mapAcpPromptContent([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
      { text: 'first\n\nsecond' },
    );
  });

  test('maps an ordinary local resource link to an external-file attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-prompt-'));
    const path = join(root, 'note.txt');
    await writeFile(path, 'hello');
    const uri = pathToFileURL(path).href;
    try {
      assert.deepEqual(
        await mapAcpPromptContent([
          { type: 'text', text: 'read this' },
          { type: 'resource_link', uri, name: 'note.txt', mimeType: 'text/plain' },
        ]),
        {
          text: `read this\n\n${uri}`,
          displayText: 'read this',
          attachments: [
            {
              kind: 'other',
              name: 'note.txt',
              mimeType: 'text/plain',
              bytes: 5,
              ref: { kind: 'external_file', absolutePath: await realpath(path) },
            },
          ],
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a resource-only prompt model-visible while its display text is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-prompt-'));
    const path = join(root, 'image.bin');
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const uri = pathToFileURL(path).href;
    try {
      const mapped = await mapAcpPromptContent([
        { type: 'resource_link', uri, name: basename(path), mimeType: 'application/octet-stream' },
      ]);
      assert.equal(mapped.text, uri);
      assert.equal(mapped.displayText, '');
      assert.equal(mapped.attachments?.[0]?.kind, 'image');
      assert.equal(mapped.attachments?.[0]?.mimeType, 'image/png');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects unadvertised content kinds and non-local or non-file resources', async () => {
    for (const prompt of [
      [{ type: 'image', data: '', mimeType: 'image/png' }],
      [{ type: 'audio', data: '', mimeType: 'audio/wav' }],
      [{ type: 'resource', resource: { uri: 'file:///tmp/x', text: 'x' } }],
      [{ type: 'resource_link', uri: 'https://example.com/x', name: 'x' }],
      [{ type: 'resource_link', uri: 'file:///tmp', name: 'tmp' }],
    ] as ContentBlock[][]) {
      await assert.rejects(mapAcpPromptContent(prompt), invalidPromptContent);
    }
  });

  test('enforces the shared attachment count and size limits before admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-prompt-'));
    const path = join(root, 'small.txt');
    await writeFile(path, 'x');
    const resource = {
      type: 'resource_link' as const,
      uri: pathToFileURL(path).href,
      name: 'small.txt',
    };
    try {
      await assert.rejects(
        mapAcpPromptContent(Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => resource)),
        invalidPromptContent,
      );
      await assert.rejects(
        mapAcpPromptContent([resource], {
          openFile: async () => ({
            size: MAX_ATTACHMENT_BYTES + 1,
            isFile: true,
            prefix: new Uint8Array(),
            canonicalPath: path,
          }),
        }),
        invalidPromptContent,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function invalidPromptContent(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32602;
}
