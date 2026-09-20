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
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PluginClientQueryInput, PluginClientQueryResult } from '@maka/runtime-host/protocol';
import { ClientPluginTransport, type ClientPluginQueryClient, type ClientPluginRemoteClient } from '../client-plugin-transport.js';

test('Client Plugin transport serves only the exact Host-projected bundle generation', async () => {
  const content = Buffer.from('window.__MakaModuleLoader__.load({id:"fixture",factory:()=>({apply(){}})})');
  const clientDigest = `sha256-${createHash('sha256').update(content).digest('hex')}`;
  const contentDigest = `sha256-${'a'.repeat(64)}`;
  const client: ClientPluginQueryClient = {
    async request(
      _operation: 'plugin.client.query',
      input: PluginClientQueryInput,
    ): Promise<PluginClientQueryResult> {
      if (input.kind === 'snapshot') {
        return {
          kind: 'snapshot',
          authorityEpoch: 1,
          revision: `sha256-${'b'.repeat(64)}`,
          entries: [
            {
              entryId: 'fixture-ui',
              extensionId: 'fixture',
              generation: 1,
              contentDigest,
              clientDigest,
              totalBytes: content.byteLength,
              dependencies: [],
            },
          ],
          failures: [],
        };
      }
      return {
        kind: 'bundle',
        extensionId: input.extensionId,
        contentDigest: input.contentDigest,
        clientDigest: input.clientDigest,
        offset: input.offset,
        totalBytes: content.byteLength,
        content: content.subarray(input.offset).toString('base64'),
        nextOffset: null,
      };
    },
  };
  const transport = new ClientPluginTransport();
  const snapshot = await transport.snapshot(client);
  const served = await transport.serve(snapshot.plugins[0]!.url);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), content.toString('utf8'));
  const alteredDigestUrl = snapshot.plugins[0]!.url.replace(clientDigest, `sha256-${'f'.repeat(64)}`);
  assert.equal((await transport.serve(alteredDigestUrl)).status, 404);

  transport.release(client);
  assert.equal((await transport.serve(snapshot.plugins[0]!.url)).status, 404);
});


test('Client Plugin streams belong to their renderer document, including late opens', async () => {
  const target = Object.assign(new EventEmitter(), { id: 42 });
  const closed: string[] = [];
  let finishOpen!: (value: { streamId: string }) => void;
  const client = {
    async request(operation: string, input: { streamId: string }) {
      if (operation === 'plugin.client.remote.stream.open') return new Promise(resolve => { finishOpen = resolve; });
      closed.push(input.streamId);
      return input;
    },
  } as unknown as ClientPluginRemoteClient;
  const transport = new ClientPluginTransport();
  const opening = transport.openStream(client, target as never, {} as never);
  target.emit('did-start-navigation', {}, 'file:///new', false, true);
  finishOpen({ streamId: 'late' });
  assert.deepEqual(await opening, { streamId: 'late' });
  assert.equal(transport.ownsStream(client, target.id, 'late'), false);
  assert.deepEqual(closed, ['late']);
  for (let i = 0; i < 20; i++) {
    const next = transport.openStream(client, target as never, {} as never);
    finishOpen({ streamId: `stream-${i}` });
    await next;
    assert.equal(target.listenerCount('destroyed'), 1);
    target.emit('did-start-navigation', {}, 'file:///new#hash', true, true);
    assert.equal(closed.length, i + 1);
    target.emit('did-start-navigation', {}, 'file:///new', false, true);
    assert.equal(closed.length, i + 2);
  }
  transport.release(client);
  assert.equal(target.listenerCount('destroyed'), 0);
  assert.equal(target.listenerCount('did-start-navigation'), 0);
});
