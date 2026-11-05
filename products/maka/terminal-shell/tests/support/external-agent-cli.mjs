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

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';

// The managed daemon's control socket uses WebSocket, including through its stdio proxy.
function websocket() {
  const input = new PassThrough();
  let bytes = Buffer.alloc(0),
    upgraded = false;
  const write = (text, opcode = 1) => {
    const payload = Buffer.from(text),
      size = payload.length;
    const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
    header[0] = 0x80 | opcode;
    header[1] = size < 126 ? size : size <= 65535 ? 126 : 127;
    if (size >= 126 && size <= 65535) header.writeUInt16BE(size, 2);
    if (size > 65535) header.writeBigUInt64BE(BigInt(size), 2);
    process.stdout.write(Buffer.concat([header, payload]));
  };
  process.stdin.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (!upgraded) {
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = bytes
        .subarray(0, end)
        .toString()
        .match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1]
        .trim();
      if (!key) throw Error('missing WebSocket handshake');
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      process.stdout.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      );
      bytes = bytes.subarray(end + 4);
      upgraded = true;
    }
    while (bytes.length >= 2) {
      const opcode = bytes[0] & 15,
        masked = !!(bytes[1] & 128);
      let length = bytes[1] & 127,
        offset = 2;
      if (length === 126) {
        if (bytes.length < 4) return;
        length = bytes.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (bytes.length < 10) return;
        length = Number(bytes.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > 8 * 1024 * 1024) throw Error('oversized fixture frame');
      if (bytes.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? bytes.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(bytes.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      bytes = bytes.subarray(offset + length);
      if (opcode === 8) {
        write('', 8);
        input.end();
        return;
      }
      if (opcode === 9) {
        write(payload, 10);
        continue;
      }
      if (opcode !== 1) throw Error('unexpected fixture opcode');
      input.write(payload);
      input.write('\n');
    }
  });
  process.stdin.on('end', () => input.end());
  return { input, write };
}

const [state, trace] = process.argv.slice(2);
if (process.argv.includes('daemon') && process.argv.includes('start')) process.exit(0);
const wire = websocket();
const record = (method) =>
  appendFileSync(trace, JSON.stringify({ method, pid: process.pid }) + '\n');
record('launch');
const lines = createInterface({ input: wire.input });
lines.on('line', (line) => {
  const { id, method } = JSON.parse(line);
  record(method);
  if (id === undefined) return;
  const current = JSON.parse(readFileSync(state, 'utf8'));
  const reply = (result) => wire.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  if (method === 'initialize') reply({ userAgent: 'native-codex-fixture' });
  else if (method === 'account/read')
    reply({ account: current.signedIn ? { type: 'apiKey' } : null });
  else if (method === 'model/list') {
    if (current.modelsFail)
      wire.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'fixture-external-discovery-failed' },
        }),
      );
    else
      reply({
        data: [
          {
            id: 'external-model',
            displayName: 'External model',
            supportedReasoningEfforts: [{ reasoningEffort: 'vendor-deep' }],
            defaultReasoningEffort: 'vendor-deep',
          },
        ],
      });
  } else
    wire.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Metadata fixture does not execute prompts' },
      }),
    );
});
lines.on('close', () => process.exit(0));
