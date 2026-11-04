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

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const [entry] = argv;
const trace = (value) => appendFileSync(process.env.MAKA_AGY_TRACE, `${JSON.stringify(value)}\n`);
trace({ argv, pid: process.pid });
if (entry === '--version') {
  process.stdout.write(process.env.MAKA_AGY_LEGACY ? 'Build label: 1.4.5\n' : '1.5.0\n');
} else {
  const expected = process.env.MAKA_AGY_LEGACY
    ? process.platform === 'linux'
      ? '--uid='
      : undefined
    : 'acp';
  if (entry !== expected) throw new Error(`Expected native entrypoint ${expected}, got ${entry}`);
  const file = process.env.MAKA_AGY_SESSION;
  let state = { id: 'fixture-agy', model: 'gemini-fixture', effort: 'medium' };
  const save = () => writeFileSync(file, JSON.stringify(state));
  const configOptions = () => [
    {
      type: 'select',
      id: 'model',
      category: 'model',
      name: 'Model',
      currentValue: state.model,
      options: [{ value: 'gemini-fixture', name: 'Gemini Fixture' }],
    },
    {
      type: 'select',
      id: 'thinking_level',
      category: 'thought_level',
      name: 'Thinking',
      currentValue: state.effort,
      options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    },
  ];
  const input = createInterface({ input: process.stdin });
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  for await (const line of input) {
    const { id, method, params } = JSON.parse(line);
    trace({ method, params });
    let result = {};
    if (method === 'initialize') {
      result = {
        protocolVersion: 1,
        agentInfo: {
          name: 'Antigravity ACP Server',
          version: process.env.MAKA_AGY_LEGACY ? '1.4.5' : '1.5.0',
        },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [],
      };
    } else if (method === 'session/new' || method === 'session/resume') {
      if (method === 'session/resume') {
        if (!existsSync(file)) throw new Error('No saved native session');
        state = JSON.parse(readFileSync(file, 'utf8'));
        if (params.sessionId !== state.id) throw new Error('Wrong native resume id');
      }
      state.mcpServers = params.mcpServers ?? [];
      save();
      result = { sessionId: state.id, configOptions: configOptions() };
    } else if (method === 'session/set_config_option') {
      if (params.configId === 'model') state.model = params.value;
      else if (params.configId === 'thinking_level') state.effort = params.value;
      else throw new Error('Unknown native config option');
      save();
      result = { configOptions: configOptions() };
    } else if (method === 'session/prompt') {
      let text = params.prompt.find((part) => part.type === 'text').text;
      const mcp = state.mcpServers?.find((server) => server.name === 'maka');
      if (mcp) {
        const call = async (method, extra = {}) => {
          const response = await fetch(mcp.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...Object.fromEntries(mcp.headers.map(({ name, value }) => [name, value])),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: method, method, ...extra }),
          });
          if (!response.ok) throw new Error(`MCP returned ${response.status}`);
          return (await response.json()).result;
        };
        await call('initialize', { params: { protocolVersion: '2025-06-18' } });
        const listed = await call('tools/list');
        if (listed.tools.length !== 1 || listed.tools[0].name !== 'SkillSearch')
          throw new Error('Unexpected Host tool catalog');
        const result = await call('tools/call', {
          params: { name: 'SkillSearch', arguments: { query: 'bridge-verification' } },
        });
        text = result.content[0].text;
      }
      send({
        method: 'session/update',
        params: {
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `native:${state.model}:${state.effort}:${text}` },
          },
        },
      });
      result = { stopReason: 'end_turn' };
    } else if (method === 'session/cancel') continue;
    else throw new Error(`Unexpected native method ${method}`);
    send({ id, result });
  }
}
