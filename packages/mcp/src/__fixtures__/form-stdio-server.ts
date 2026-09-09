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
import { setTimeout as delay } from 'node:timers/promises';
import { Server, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { mcpFixtureFormRequest } from './form-server.js';

const STATE = 'stdio-private-continuation-state';
serveStdio(
  () => {
    const server = new Server(
      { name: 'modern-stdio-form', version: '1' },
      {
        capabilities: { tools: {} },
      },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'ask_user',
          inputSchema: { type: 'object' },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async (_request, context) => {
      const answer = context.mcpReq.inputResponses?.form;
      if (answer === undefined)
        return inputRequired({
          inputRequests: { form: mcpFixtureFormRequest() },
          requestState: STATE,
        });
      assert.equal(context.mcpReq.requestState(), STATE);
      process.stderr.write(`continuation: ${STATE}\n`);
      await delay(30);
      return { content: [{ type: 'text', text: 'Form completed' }], structuredContent: { answer } };
    });
    return server;
  },
  { legacy: 'reject' },
);
