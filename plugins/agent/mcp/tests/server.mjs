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
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [mode, record] = process.argv.slice(2);
const log = (event) => appendFileSync(record, JSON.stringify(event) + '\n');
log({ pid: process.pid });
if (mode === 'environment')
  log({
    environment: {
      database: process.env.DATABASE_URL ?? null,
      proxy: process.env.HTTPS_PROXY ?? null,
      secret: process.env.MCP_ALLOWED_SECRET ?? null,
      explicit: process.env.MCP_EXPLICIT ?? null,
      path: !!process.env.PATH,
    },
  });
const pending = new Map();
const tools = ['echo', 'error', 'media', 'slow', 'hang', 'change'].map((name) => ({
  name,
  description: `Fixture ${name}`,
  inputSchema:
    mode === 'object-union' && name === 'echo'
      ? {
          $ref: '#/$defs/Arguments',
          $defs: {
            Arguments: {
              type: 'object',
              properties: { marker: { type: 'string' } },
              required: ['marker'],
              additionalProperties: false,
            },
          },
          oneOf: [
            { properties: { marker: { const: 'MCP_RESULT' } } },
            { properties: { marker: { const: 'OTHER_RESULT' } } },
          ],
        }
      : { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: true },
}));
function receive(message, send) {
  log({ method: message.method, id: message.id, params: message.params });
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    if (mode === 'startup-hang') return;
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fixture', version: '1' },
    });
  } else if (message.method === 'tools/list') {
    if (mode === 'large-catalog') {
      const page = Number(message.params?.cursor ?? 0);
      reply({
        tools: Array.from({ length: 17 }, (_, index) => ({
          name: `tool_${page * 17 + index}`,
          description: 'catalog payload '.repeat(80),
          inputSchema: { type: 'object' },
        })),
        ...(page < 64 ? { nextCursor: String(page + 1) } : {}),
      });
      return;
    }
    if (mode === 'repeated-cursor') {
      reply({ tools: [], nextCursor: 'same' });
      return;
    }
    reply(
      message.params?.cursor
        ? { tools: tools.slice(3) }
        : { tools: tools.slice(0, 3), nextCursor: 'page2' },
    );
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'hang') {
      pending.set(message.id, reply);
      return;
    }
    if (name === 'slow') {
      setTimeout(() => reply({ content: [{ type: 'text', text: 'slow' }] }), 150);
      return;
    }
    if (name === 'change') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    reply({
      content:
        name === 'media'
          ? [
              { type: 'text', text: 'caption', annotations: { audience: ['assistant'] } },
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8x8AAAAASUVORK5CYII=',
              },
              {
                type: 'resource_link',
                uri: 'https://example.test/artifact',
                name: 'result',
                mimeType: 'text/plain',
              },
            ]
          : [{ type: 'text', text: mode === 'stdio-large' ? 'x'.repeat(16 * 1024 * 1024 + 1) : name === 'error' ? 'business failed' : JSON.stringify(args) }],
      structuredContent: args,
      isError: name === 'error',
      _meta: { fixture: true },
    });
  } else if (message.method === 'notifications/cancelled') {
    if (mode !== 'ignore-cancel')
      pending.get(message.params.requestId)?.({
        content: [{ type: 'text', text: 'settled after cancellation' }],
        isError: true,
      });
  }
}
if (mode.startsWith('http')) {
  const server = createServer(async (request, response) => {
    log({ http: request.method, authorization: request.headers.authorization });
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'DELETE' ? 204 : 405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (!('id' in message)) {
      receive(message, () => {});
      response.writeHead(202).end();
      return;
    }
    receive(message, (result) => {
      if (mode.startsWith('http-large') && message.method === 'tools/call') {
        result.result.content = [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) }];
        result.result.structuredContent = { marker: 'large-result-complete' };
        const body = JSON.stringify(result);
        if (mode === 'http-large-sse') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end('data: ' + body + '\n\n');
        } else {
          response.writeHead(200, {
            'content-type': 'application/json',
            ...(mode === 'http-large-json' ? { 'content-length': Buffer.byteLength(body) } : {}),
          });
          response.end(body);
        }
      } else if (mode === 'http-sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': heartbeat\r');
        setImmediate(() => {
          response.write('\n\r');
          setImmediate(() => response.end('\ndata: ' + JSON.stringify(result) + '\r\n\r\n'));
        });
      } else
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(record + '.url.tmp', `http://127.0.0.1:${server.address().port}/mcp`);
    renameSync(record + '.url.tmp', record + '.url');
  });
} else {
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) =>
    receive(JSON.parse(line), (result) => process.stdout.write(JSON.stringify(result) + '\n')),
  );
}
