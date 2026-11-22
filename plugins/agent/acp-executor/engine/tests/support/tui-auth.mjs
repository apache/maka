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

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const [trace, port, marker] = process.argv.slice(2);
const control = connect(Number(port), '127.0.0.1');
await once(control, 'connect');
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const record = (value) => appendFileSync(trace, `${JSON.stringify(value)}\n`);
const update = (value) =>
  send({ method: 'session/update', params: { sessionId: 'authenticated-session', update: value } });
let authentication;
createInterface({ input: control }).on('line', (line) => {
  if (line === 'continue' && authentication !== undefined) {
    writeFileSync(marker, 'synthetic login completed');
    reply(authentication, {});
    authentication = undefined;
  }
});
record({ method: 'spawn', pid: process.pid });
control.write(`${process.pid}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  record(request);
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 2,
        info: { name: existsSync(marker) ? 'fixture-ready' : 'fixture-v2', version: '1' },
        capabilities: { session: {} },
        authMethods: ['login', 'unsafe', 'cancel'].map((methodId) => ({
          methodId,
          name: methodId,
          type: 'agent',
        })),
      });
      break;
    case 'auth/login':
      authentication = id;
      process.stderr.write(
        `Open the following link to authenticate the ACP server: ${params.methodId === 'unsafe' ? 'http://insecure.example.invalid/' : 'https://login.example.invalid/authorize?state=private-fixture'}\n`,
      );
      break;
    case 'session/new':
      if (!existsSync(marker)) send({ id, error: { code: -32000, message: 'Login required' } });
      else reply(id, { sessionId: 'authenticated-session' });
      break;
    case 'session/prompt': {
      const text = params.prompt.at(-1).text;
      reply(id, { messageId: 'user-answer' });
      // ACP v2 completion is tied to this exact accepted user-message echo.
      update({ sessionUpdate: 'user_message', messageId: 'user-answer', content: params.prompt });
      update({ sessionUpdate: 'state_update', state: 'running' });
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer',
        content: { type: 'text', text: `answer ${text}` },
      });
      update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `Unexpected method ${method}` } });
  }
}
control.end();
