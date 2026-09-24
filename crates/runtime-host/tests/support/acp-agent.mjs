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

import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const control = connect(Number(process.argv[3]), '127.0.0.1');
await once(control, 'connect');
const record = (value) => appendFileSync(process.argv[2], `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (value) =>
  send({ method: 'session/update', params: { sessionId: 'acp-persistent', update: value } });
let model = 'small';
let callbackPrompt;
let authentication;
createInterface({ input: control }).on('line', (line) => {
  if (line === 'continue' && authentication !== undefined) reply(authentication, {});
});
const options = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'small', name: 'Small' },
      { value: 'large', name: 'Large' },
    ],
  },
];
record({ method: 'spawn', pid: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  record(request);
  const { id, method, params } = request;
  if (method === undefined) {
    if (request.error) throw new Error(JSON.stringify(request.error));
    if (id === 'read-file') {
      if (request.result.content !== 'fixture contents\n')
        throw new Error('Host read returned wrong contents');
      send({
        id: 'write-file',
        method: 'fs/write_text_file',
        params: {
          sessionId: 'acp-persistent',
          path: `${process.cwd()}/written.txt`,
          content: 'written through Host\n',
        },
      });
    } else if (id === 'write-file') {
      send({
        id: 'permission',
        method: 'session/request_permission',
        params: {
          sessionId: 'acp-persistent',
          toolCall: { toolCallId: 'permission-tool', title: 'Inspect fixture', status: 'pending' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    } else if (id === 'permission') {
      if (
        request.result.outcome.outcome !== 'selected' ||
        request.result.outcome.optionId !== 'allow-once'
      )
        throw new Error('Wrong permission response');
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'callbacks complete' },
      });
      reply(callbackPrompt, { stopReason: 'end_turn' });
    }
    continue;
  }
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: ['login', 'unsafe', 'cancel'].map((id) => ({ id, name: id })),
      });
      break;
    case 'authenticate':
      authentication = id;
      process.stderr.write('unrelated diagnostic https://ignored.example.invalid/\n');
      process.stderr.write(
        `Open the following link to authenticate the ACP server: ${params.methodId === 'unsafe' ? 'http://insecure.example.invalid/login' : 'https://login.example.invalid/authorize?state=fixture'}\n`,
      );
      break;
    case 'session/new':
      reply(id, { sessionId: 'acp-persistent', configOptions: options() });
      break;
    case 'session/load':
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'REPLAY MUST NOT APPEAR' },
      });
      reply(id, { configOptions: options() });
      break;
    case 'session/set_config_option':
      model = params.value;
      reply(id, { configOptions: options() });
      break;
    case 'session/prompt': {
      const text = params.prompt.at(-1).text;
      if (text === 'callbacks') {
        callbackPrompt = id;
        send({
          id: 'read-file',
          method: 'fs/read_text_file',
          params: { sessionId: 'acp-persistent', path: `${process.cwd()}/input.txt` },
        });
        break;
      }
      if (text === 'lose') process.exit(0);
      if (text === 'wait') {
        control.write('waiting\n');
        break;
      }
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: `thinking ${text}` },
      });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'same-tool-id',
        title: 'Inspect',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'example.txt' },
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'same-tool-id',
        status: 'completed',
        rawOutput: { found: true },
      });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer ' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      reply(id, { stopReason: 'end_turn' });
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `Unexpected method ${method}` } });
  }
}
control.end();
