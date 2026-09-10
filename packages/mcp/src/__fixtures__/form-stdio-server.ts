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
const FUTURE_STATE = `future-state-prefix-${'x'.repeat(3_000)}`;
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
    let generationCall = 0;
    let lastState = STATE;
    let firstState = '';
    server.setRequestHandler('tools/call', async (request, context) => {
      const mode = request.params.arguments?.mode;
      if (mode === 'future-diagnostic') {
        process.stderr.write(`${FUTURE_STATE}\n`);
        await delay(30);
        return { content: [{ type: 'text', text: 'diagnosed' }] };
      }
      if (mode === 'unicode-diagnostic') {
        const encoded = Buffer.from(lastState);
        process.stderr.write(encoded.subarray(0, 1));
        await delay(30);
        process.stderr.write(encoded.subarray(1));
        process.stderr.write('\nsafe diagnostic\n');
        await delay(30);
        return { content: [{ type: 'text', text: 'diagnosed' }] };
      }
      if (mode === 'first-diagnostic') {
        process.stderr.write(`earliest continuation: ${firstState}\n`);
        await delay(30);
        return { content: [{ type: 'text', text: 'diagnosed' }] };
      }
      if (mode === 'diagnostic') {
        process.stderr.write(`late continuation: ${lastState}\nsafe diagnostic\n`);
        await delay(30);
        return { content: [{ type: 'text', text: 'diagnosed' }] };
      }
      const answer = context.mcpReq.inputResponses?.form;
      if (answer === undefined) {
        generationCall += 1;
        lastState =
          mode === 'future'
            ? FUTURE_STATE
            : mode === 'unicode'
              ? `敏感-${STATE}`
              : mode === 'control'
                ? `${STATE}\ncontrol-private-suffix`
                : mode === 'retention'
                  ? `${STATE}-${generationCall}`
                  : mode === 'byte-retention'
                    ? `${STATE}-${generationCall}-${'x'.repeat(16_000)}`
                    : STATE;
        firstState ||= lastState;
        if (mode === 'before') {
          process.stderr.write(`before response: ${lastState}\n`);
          await delay(30);
        }
        return inputRequired({
          inputRequests: { form: mcpFixtureFormRequest() },
          requestState: lastState,
        });
      }
      assert.equal(context.mcpReq.requestState(), lastState);
      const completedState = lastState;
      if (mode === 'partial' || mode === 'continued') {
        process.stderr.write(lastState.slice(0, 12) + (mode === 'continued' ? '\\\n' : ''));
        await delay(30);
        setTimeout(
          () => process.stderr.write(`${completedState.slice(12)}\nsafe diagnostic\n`),
          60,
        );
      } else {
        process.stderr.write(`continuation: ${lastState}\n`);
        await delay(30);
        setTimeout(
          () => process.stderr.write(`after completion: ${completedState}\nsafe diagnostic\n`),
          60,
        );
      }
      return { content: [{ type: 'text', text: 'Form completed' }], structuredContent: { answer } };
    });
    return server;
  },
  { legacy: 'reject' },
);
