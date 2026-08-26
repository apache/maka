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
import { Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { runMakaAcpStdioServer } from '../acp/stdio-server.js';

describe('Maka ACP stdio server', () => {
  test('answers initialize without Runtime Host input or dependencies', async () => {
    const harness = createHarness([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      })}\n`,
    ]);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        },
      },
    ]);
  });

  test('returns zero after normal EOF', async () => {
    const harness = createHarness([]);

    assert.equal(await harness.run(), 0);
  });

  test('returns a JSON-RPC parse error and then zero after EOF', async () => {
    const harness = createHarness(['not json\n']);

    assert.equal(await harness.run(), 0);
    assert.deepEqual(harness.stdoutMessages(), [
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
  });

  test('propagates a stdin transport error', async () => {
    const transportError = new Error('stdin transport failed');
    const stdin = Readable.from(
      (async function* () {
        throw transportError;
      })(),
    );
    const harness = createHarness([], { stdin });

    await assert.rejects(harness.run(), (error: unknown) => error === transportError);
  });
});

function createHarness(chunks: string[], options: { readonly stdin?: Readable } = {}) {
  const stdin = options.stdin ?? Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const stdoutChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {
    run: () => runMakaAcpStdioServer({ version: '0.2.0' }, { stdin, stdout }),
    stdoutMessages: () =>
      Buffer.concat(stdoutChunks)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
  };
}
