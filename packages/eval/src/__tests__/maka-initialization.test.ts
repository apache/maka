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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  resolveStorageRoot,
  resolveExistingStorageRootControlDirectory,
} from '@maka/storage/root-authority';

test('official Maka shim keeps authenticated initialization through preflight and Host restart', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-initialization-'));
  const state = join(root, 'state');
  const artifacts = join(root, 'artifacts');
  const apiKey = 'eval-fixture-api-secret';
  const proxyPassword = 'eval-fixture-proxy-secret';
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const policies: string[] = [];
  const tunnels: string[] = [];
  const failures: unknown[] = [];
  const owners: number[] = [];
  let rejectPreflight = true;
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      const policy = await readFile(join(state, 'runtime-policy.json'), 'utf8');
      assert.equal(JSON.parse(policy).policy.privacy.incognitoActive, true);
      policies.push(policy);
      const capability = await resolveStorageRoot({ path: state, kind: 'interactive' });
      const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
      owners.push(
        JSON.parse(await readFile(join(controlDirectory, 'registration.json'), 'utf8')).pid,
      );
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: request.url!, body });
      if (request.url === '/v1/models') {
        if (rejectPreflight) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }] }),
        );
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(body.model, 'deepseek-chat');
      if (body.stream !== true) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'fixture-title',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-chat',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Initialization test' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }),
        );
        return;
      }
      const messages = body.messages as { role: string; content: unknown }[];
      const toolCompleted = messages.some((message) => message.role === 'tool');
      if (!toolCompleted) {
        assert.ok(
          body.tools?.some(
            (tool: { function?: { name: string } }) => tool.function?.name === 'tool_search',
          ),
          JSON.stringify(body).slice(0, 1800),
        );
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) =>
        response.write(
          `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      chunk(
        toolCompleted
          ? { role: 'assistant', content: 'Initialization verified.' }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-tool',
                  type: 'function',
                  function: { name: 'tool_search', arguments: JSON.stringify({ query: 'Bash' }) },
                },
              ],
            },
        null,
      );
      chunk({}, toolCompleted ? 'stop' : 'tool_calls', {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
      });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const proxy = createServer((request, response) => {
    const url = new URL(request.url!);
    tunnels.push(url.host);
    if (
      url.hostname !== 'provider.invalid' ||
      request.headers['proxy-authorization'] !==
        `Basic ${Buffer.from(`eval-user:${proxyPassword}`).toString('base64')}`
    ) {
      failures.push(new Error('Unexpected proxy target or missing authentication'));
      response.writeHead(407).end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: url.pathname,
        method: request.method,
        headers: request.headers,
      },
      (received) => {
        response.writeHead(received.statusCode!, received.headers);
        received.pipe(response);
      },
    );
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url!);
    if (
      request.url !== 'provider.invalid:80' ||
      request.headers['proxy-authorization'] !==
        `Basic ${Buffer.from(`eval-user:${proxyPassword}`).toString('base64')}`
    ) {
      failures.push(new Error('Unexpected proxy target or missing authentication'));
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const upstream = connect(address.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === 'object');
  try {
    const payload = {
      rootPath: state,
      artifactRoot: artifacts,
      baseUrl: 'http://provider.invalid/v1',
      hostSettlementTimeoutMs: 5_000,
      connection: { providerType: 'deepseek', apiKeyEnvironment: 'MAKA_FIXTURE_API_KEY' },
      execution: {
        executionId: randomUUID(),
        session: {
          workspace: { kind: 'host_path', path: root },
          modelTarget: { kind: 'explicit', connectionSlug: 'fixture', model: 'deepseek-chat' },
          permissionMode: 'bypass',
        },
        content: { text: 'Find the Bash tool, then reply.' },
        maxSteps: 4,
      },
    };
    for (const failPreflight of [true, false]) {
      rejectPreflight = failPreflight;
      const child: ReturnType<typeof spawn> = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../harbor-maka-subject.js', import.meta.url)),
          Buffer.from(JSON.stringify(payload)).toString('base64url'),
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            OPENAI_API_KEY: '',
            ANTHROPIC_API_KEY: '',
            DEEPSEEK_API_KEY: '',
            MAKA_FIXTURE_API_KEY: apiKey,
            HTTPS_PROXY: `http://eval-user:${proxyPassword}@127.0.0.1:${proxyAddress.port}`,
            MAKA_EVAL_RESULT_TOKEN: '1'.repeat(32),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      assert.ok(child.stdout && child.stderr);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
      const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      clearTimeout(timer);
      assert.deepEqual(failures, []);
      if (failPreflight) {
        assert.equal(exit, 1);
        assert.equal(requests.length, 1);
        continue;
      }
      assert.equal(
        exit,
        0,
        `${stdout}\n${stderr}\n${JSON.stringify({ requests, tunnels })}\n${await readFile(join(state, 'runtime-host-candidate.log'), 'utf8').catch(() => '')}`,
      );
      const frame = stdout.split('\n').find((line) => line.startsWith('MAKA-EVAL-RESULT-V1 '));
      assert.ok(frame);
      const result = JSON.parse(Buffer.from(frame.split(' ')[4]!, 'base64url').toString());
      assert.equal(result.status, 'completed');
      assert.ok(result.usage.inputTokens > 0);
      assert.equal(requests.filter((request) => request.path === '/v1/models').length, 2);
      assert.equal(requests.filter((request) => request.body.stream === true).length, 2);
      assert.ok(tunnels.length >= 2);
      assert.equal(new Set(policies).size, 1);
      assert.equal(new Set(owners).size, 3);
      assert.ok((await readdir(artifacts)).includes('runtime.sqlite'));
      for (const file of await readdir(artifacts)) {
        const contents = await readFile(join(artifacts, file));
        assert.equal(contents.includes(Buffer.from(apiKey)), false, file);
        assert.equal(contents.includes(Buffer.from(proxyPassword)), false, file);
      }
    }
  } finally {
    proxy.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
