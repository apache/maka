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
import { test } from 'node:test';
import { PluginAgentService } from '../plugin-agent-service.js';
import { PluginAttachmentService } from '../plugin-attachment-service.js';
import { PluginFilesystemService } from '../plugin-fs-service.js';
import { Context } from '../plugin-kernel.js';
import { PluginShellService } from '../plugin-shell-service.js';
import { PluginWebService } from '../plugin-web-service.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('resource services preserve the current Session and cancellation context', async () => {
  const root = new Context();
  const agents = new PluginAgentService(root);
  const fs = new PluginFilesystemService(root, agents);
  const shell = new PluginShellService(root, agents);
  const web = new PluginWebService(root, agents);
  const attachments = new PluginAttachmentService(root, agents);
  const calls: string[] = [];
  fs.bindRuntime({
    execute: async (operation, invocation) => {
      calls.push(`fs:${operation.kind}:${invocation.sessionId}`);
      return operation;
    },
  });
  shell.bindRuntime({
    run: async (options, invocation) => {
      calls.push(`shell:${options.command}:${invocation.turnId}`);
      return { ok: true };
    },
  });
  web.bindRuntime({
    search: async (input) => {
      calls.push(`search:${input.query}:${input.sessionId}`);
      return { ok: true, provider: 'tavily', results: [] };
    },
    fetch: async (input) => {
      calls.push(`fetch:${input.url}:${input.sessionId}`);
      return 'body';
    },
  });
  attachments.bindRuntime({
    create: async (input, invocation) => {
      calls.push(`attachment:${input.name}:${invocation.turnId}`);
      return {
        kind: 'other',
        name: input.name,
        mimeType: input.mimeType,
        bytes: 1,
        ref: { kind: 'session_file', sessionId: invocation.sessionId, relativePath: 'a' },
      };
    },
    read: async () => new Uint8Array([1]),
    list: async () => [],
  });
  const context: MakaToolContext = {
    sessionId: 'session-a',
    turnId: 'turn-a',
    cwd: '/workspace',
    toolCallId: 'call-a',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };

  await agents.withInvocation(context, async () => {
    await fs.read('README.md');
    await shell.run({ command: 'pwd' });
    await web.search('  maka  ');
    assert.equal(await web.fetch('https://example.com'), 'body');
    await attachments.create({ name: 'a.txt', mimeType: 'text/plain', content: 'a' });
  });

  assert.deepEqual(calls, [
    'fs:read:session-a',
    'shell:pwd:turn-a',
    'search:maka:session-a',
    'fetch:https://example.com/:session-a',
    'attachment:a.txt:turn-a',
  ]);
  await root.fiber.dispose();
});
