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

import net from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://')
  throw Error('Only the real foreground app-server JSONL invocation is supported');
const address = new URL(process.env.FAKE_CONTROL);
if (address.hostname !== '127.0.0.1') throw Error('Controller must be owned loopback');
const rootPid = Number(process.env.FAKE_ROOT_PID);
if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw Error('Missing original Root PID');
const socket = net.connect(Number(address.port), address.hostname);
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});
let job = null,
  thread = null,
  turn = null,
  finished = false,
  mcp = null,
  session = null,
  protocol = null;
const record = (kind, fields = {}) =>
  new Promise((resolve, reject) =>
    socket.write(
      JSON.stringify({ kind, job: job?.label ?? null, pid: process.pid, ...fields }) + '\n',
      (error) => (error ? reject(error) : resolve()),
    ),
  );
const send = (value) =>
  new Promise((resolve, reject) =>
    process.stdout.write(JSON.stringify(value) + '\n', (error) =>
      error ? reject(error) : resolve(),
    ),
  );
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const event = (method, params) => send({ jsonrpc: '2.0', method, params });
const diagnosticText = (value, limit = 256) => {
  if (typeof value !== 'string') return undefined;
  for (const header of Object.values(mcp?.http_headers ?? {}))
    if (typeof header === 'string' && header.length) value = value.replaceAll(header, '[redacted]');
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /((?:"?(?:password|passwd|api[_-]?key|access[_-]?token|authorization)"?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]',
    )
    .slice(0, limit);
};
function sessionCreateError(result) {
  const stage = 'SessionCreate tools/call isError';
  const content = result.content?.find((part) => part.type === 'text');
  if (!content) return Error(`${stage}: missing error text`);
  let error;
  try {
    error = JSON.parse(content.text);
  } catch {
    return Error(`${stage}: invalid error JSON`);
  }
  const receipt = error?.observation?.receipt;
  const outcome = receipt?.outcome;
  const returned = outcome?.result;
  const value = returned?.value;
  const cleanup = receipt?.cleanup;
  return Error(
    JSON.stringify({
      stage,
      message: diagnosticText(error?.message),
      operationId: diagnosticText(error?.operationId),
      receipt: {
        kind: diagnosticText(receipt?.kind),
        diagnostic: diagnosticText(receipt?.diagnostic),
      },
      outcome: {
        kind: diagnosticText(outcome?.kind),
        diagnostic: diagnosticText(outcome?.diagnostic),
      },
      result: {
        kind: diagnosticText(returned?.kind),
        diagnostic: diagnosticText(returned?.diagnostic),
        valueKind: diagnosticText(value?.kind),
        rejectionReason: value?.kind === 'rejected' ? diagnosticText(value.reason) : undefined,
        childSessionId: value?.kind === 'created' ? diagnosticText(value.session?.id) : undefined,
      },
      cleanup: {
        kind: diagnosticText(cleanup?.kind),
        diagnostic: diagnosticText(cleanup?.diagnostic),
      },
    }),
  );
}
const fail = async (error) => {
  const message =
    error instanceof SyntaxError
      ? 'Invalid protocol JSON'
      : diagnosticText(String(error?.message ?? 'Provider failure'), 4096);
  await record('failure', { message }).catch(() => {});
  process.exit(1);
};
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(finished ? 0 : 1));
await record('hello', { cwd: process.cwd(), home: process.env.HOME, rootPid });

async function rpc(method, params, id) {
  const headers = {
    ...mcp.http_headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (session) headers['mcp-session-id'] = session;
  if (protocol) headers['mcp-protocol-version'] = protocol;
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }),
  });
  if (!response.ok) throw Error('MCP rejected request');
  session = response.headers.get('mcp-session-id') ?? session;
  if (id === undefined) {
    await response.arrayBuffer();
    return;
  }
  let answer;
  if (response.headers.get('content-type')?.includes('application/json'))
    answer = await response.json();
  else {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = '';
    try {
      read: for (;;) {
        const { done, value } = await reader.read();
        pending += decoder
          .decode(value ?? new Uint8Array(), { stream: !done })
          .replaceAll('\r\n', '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) {
            const parsed = JSON.parse(data);
            if (parsed.id === id) {
              answer = parsed;
              break read;
            }
          }
        }
        if (done) break;
      }
    } finally {
      await reader.cancel();
    }
  }
  if (answer?.id !== id || answer.error || !answer.result) throw Error('Invalid MCP result');
  if (method === 'initialize') {
    protocol = answer.result.protocolVersion;
    if (typeof protocol !== 'string') throw Error('MCP omitted its negotiated protocol');
  }
  return answer.result;
}
async function hostEffect() {
  await rpc(
    'initialize',
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'owned-external-case', version: '1' },
    },
    101,
  );
  await rpc('notifications/initialized', {});
  const tools = await rpc('tools/list', {}, 102);
  if (!tools.tools.some((tool) => tool.name === 'SessionCreate'))
    throw Error('Real SessionCreate unavailable');
  await record('host_call', { name: 'SessionCreate' });
  const result = await rpc(
    'tools/call',
    {
      name: 'SessionCreate',
      arguments: {
        title: job.title,
        automaticTitle: false,
        labels: [],
        backend: null,
        workspace: { kind: 'session', sessionId: job.session },
      },
    },
    103,
  );
  if (result.isError) throw sessionCreateError(result);
  const created = JSON.parse(result.content.find((part) => part.type === 'text').text);
  if (created?.kind !== 'created')
    throw Error(
      JSON.stringify({
        stage: 'SessionCreate business result',
        kind: diagnosticText(created?.kind),
        reason: created?.kind === 'rejected' ? diagnosticText(created.reason) : undefined,
      }),
    );
  if (typeof created.session?.id !== 'string' || created.session.id.trim().length === 0)
    throw Error('SessionCreate omitted its actual child session ID');
  if (created.session.title !== job.title || created.session.parentSessionId !== job.session)
    throw Error('SessionCreate child title or parent differs from the original job');
  await record('effect', {
    session: created.session.id,
    title: created.session.title,
  });
  if (session) {
    const response = await fetch(mcp.url, {
      method: 'DELETE',
      headers: { ...mcp.http_headers, 'mcp-session-id': session, 'mcp-protocol-version': protocol },
    });
    if (!response.ok) throw Error('MCP session did not close');
    await response.arrayBuffer();
  }
}
async function terminal(status) {
  if (finished || !job) throw Error('Duplicate terminal');
  finished = true;
  await event('turn/completed', { threadId: thread, turn: { id: turn, status } });
  await record('terminal', { thread, turn, status });
  socket.end(() => process.exit(0));
}
let requests = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  requests = requests
    .then(async () => {
      const { id, method, params = {} } = JSON.parse(line);
      await record('method', { method });
      if (method === 'initialize') return reply(id, { userAgent: 'owned-codex-upstream' });
      if (method === 'initialized') return;
      if (method === 'thread/start') {
        if (thread) throw Error('Second thread');
        thread = randomUUID();
        mcp = params.config.mcp_servers.maka;
        return reply(id, {
          thread: { id: thread },
          model: params.model,
          approvalPolicy: 'never',
          sandbox: { type: 'dangerFullAccess' },
        });
      }
      if (method === 'thread/inject_items') {
        if (params.threadId !== thread) throw Error('Wrong instruction thread');
        return reply(id, {});
      }
      if (method === 'turn/start') {
        if (turn || params.threadId !== thread) throw Error('Duplicate or wrong turn');
        const text = params.input.find((part) => part.type === 'text').text,
          marker = text.lastIndexOf('MAKA_EXTERNAL_CASE ');
        if (marker < 0) throw Error('Missing closed test input');
        job = JSON.parse(text.slice(marker + 'MAKA_EXTERNAL_CASE '.length));
        if (!['A', 'B', 'C'].includes(job.label)) throw Error('Unknown test scenario');
        turn = randomUUID();
        await reply(id, { turn: { id: turn } });
        await record('started', { thread, turn });
        if (job.effect) await hostEffect();
        const checkpoint = 'bound:' + thread + ':' + turn;
        await event('item/completed', {
          threadId: thread,
          turnId: turn,
          item: { type: 'agentMessage', id: 'answer-' + turn, text: checkpoint },
        });
        await record('ready', { thread, turn, checkpoint });
        return;
      }
      if (method === 'turn/interrupt') {
        if (params.threadId !== thread || params.turnId !== turn)
          throw Error('Interrupt crossed job boundary');
        await record('interrupt', { thread, turn });
        await reply(id, {});
        return terminal('interrupted');
      }
      throw Error('Unsupported method; never resume or resubmit');
    })
    .catch(fail);
});
let controls = Promise.resolve();
createInterface({ input: socket }).on('line', (line) => {
  controls = controls
    .then(async () => {
      const command = JSON.parse(line);
      if (command.action === 'exit') {
        finished = true;
        socket.end(() => process.exit(0));
        return;
      }
      if (
        command.action === 'root_reaped' &&
        job?.label === 'C' &&
        command.pid === rootPid &&
        !finished
      ) {
        finished = true;
        await record('root_gone', { thread, turn });
        socket.end(() => process.exit(0));
        return;
      }
      if (command.action === 'challenge' && job && !finished)
        return record('challenge', { nonce: command.nonce, thread, turn });
      if (command.action === 'complete' && job?.label === 'B') return terminal('completed');
      throw Error('Invalid controller action');
    })
    .catch(fail);
});
// Root EOF deliberately does not close native stdin. The held controller may
// notify this fake of its exact Root's reaped death, never publish a Domain ACK.
