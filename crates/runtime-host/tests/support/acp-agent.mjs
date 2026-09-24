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
const v2 = process.argv[4] === '2';
// Mode 3 reproduces legacy peers that echo the requested version with a v1 envelope.
const record = (value) => appendFileSync(process.argv[2], `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (value) =>
  send({ method: 'session/update', params: { sessionId: 'acp-persistent', update: value } });
let model = 'small';
let callbackPrompt;
let callbackMode;
let authentication;
createInterface({ input: control }).on('line', (line) => {
  if (line === 'continue' && authentication !== undefined) reply(authentication, {});
  if (line === 'cancel-permission') {
    for (let index = 0; index < 64; index++) {
      update({
        sessionUpdate: 'agent_thought_chunk',
        ...(v2 ? { messageId: 'permission-progress' } : {}),
        content: { type: 'text', text: `permission progress ${index}\n` },
      });
      process.stderr.write('permission diagnostic\n');
    }
    send({ method: '$/cancel_request', params: { requestId: 'permission' } });
  }
});
const options = () => [
  {
    [v2 ? 'configId' : 'id']: 'model',
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
control.write(`${process.pid}\n`);
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
      const cancelled = callbackMode === 'peer-cancel';
      if (
        cancelled
          ? request.result.outcome.outcome !== 'cancelled'
          : request.result.outcome.outcome !== 'selected' ||
            request.result.outcome.optionId !== 'allow-once'
      )
        throw new Error('Wrong permission response');
      update({
        sessionUpdate: 'agent_message_chunk',
        ...(v2 ? { messageId: 'callbacks-answer' } : {}),
        content: { type: 'text', text: cancelled ? 'permission cancelled' : 'callbacks complete' },
      });
      if (v2) update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      else reply(callbackPrompt, { stopReason: 'end_turn' });
    }
    continue;
  }
  switch (method) {
    case 'initialize':
      reply(
        id,
        v2
          ? {
              protocolVersion: 2,
              info: { name: 'fixture-v2', version: '1' },
              capabilities: { session: {} },
              authMethods: ['login', 'unsafe', 'cancel'].map((methodId) => ({
                methodId,
                name: methodId,
                type: 'agent',
              })),
            }
          : {
              protocolVersion: process.argv[4] === '3' ? params.protocolVersion : 1,
              agentCapabilities: { loadSession: true },
              authMethods: ['login', 'unsafe', 'cancel'].map((id) => ({ id, name: id })),
            },
      );
      break;
    case 'authenticate':
    case 'auth/login':
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
    case 'session/resume':
      if (!v2 || params.replayFrom != null) throw new Error('Unexpected replay request');
      update({ sessionUpdate: 'state_update', state: 'idle' });
      reply(id, { configOptions: options() });
      break;
    case 'session/set_config_option':
      if (v2 && (params.configId !== 'model' || params.type !== 'id'))
        throw new Error('Wrong v2 configuration wire shape');
      model = params.value;
      reply(id, { configOptions: options() });
      break;
    case 'session/prompt': {
      const text = params.prompt.at(-1).text;
      if (v2) {
        reply(id, { messageId: `user-${text}` });
        update({
          sessionUpdate: 'user_message',
          messageId: `user-${text}`,
          content: params.prompt,
        });
        update({ sessionUpdate: 'state_update', state: 'running' });
      }
      if (text === 'callbacks' || text === 'peer-cancel') {
        callbackPrompt = id;
        callbackMode = text;
        if (v2) {
          send({
            id: 'permission',
            method: 'session/request_permission',
            params: {
              sessionId: 'acp-persistent',
              title: 'Run fixture command',
              description: 'Confirm the command operation',
              subject: { type: 'command', command: 'printf fixture-command', cwd: process.cwd() },
              options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          });
          break;
        }
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
        ...(v2 ? { messageId: `thought-${text}` } : {}),
        content: { type: 'text', text: `thinking ${text}` },
      });
      update({
        sessionUpdate: v2 ? 'tool_call_update' : 'tool_call',
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
      if (v2) {
        update({
          sessionUpdate: 'agent_message_chunk',
          messageId: `answer-${text}`,
          content: { type: 'text', text: 'OBSOLETE' },
        });
        update({
          sessionUpdate: 'agent_message',
          messageId: `answer-${text}`,
          content: [{ type: 'text', text: 'answer ' }],
        });
        update({
          sessionUpdate: 'agent_message_chunk',
          messageId: `answer-${text}`,
          content: { type: 'text', text },
        });
        update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      } else {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'answer ' },
        });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        reply(id, { stopReason: 'end_turn' });
      }
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `Unexpected method ${method}` } });
  }
}
control.end();
