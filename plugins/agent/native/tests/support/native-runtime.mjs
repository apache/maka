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

// Native wire fixtures. The TCP control channel belongs only to the behavioral tests.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// The managed daemon's control socket uses WebSocket, including through its stdio proxy.
function websocket() {
  const input = new PassThrough();
  let bytes = Buffer.alloc(0),
    upgraded = false;
  const write = (text, opcode = 1) => {
    const payload = Buffer.from(text),
      size = payload.length;
    const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
    header[0] = 0x80 | opcode;
    header[1] = size < 126 ? size : size <= 65535 ? 126 : 127;
    if (size >= 126 && size <= 65535) header.writeUInt16BE(size, 2);
    if (size > 65535) header.writeBigUInt64BE(BigInt(size), 2);
    process.stdout.write(Buffer.concat([header, payload]));
  };
  process.stdin.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    if (!upgraded) {
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = bytes
        .subarray(0, end)
        .toString()
        .match(/Sec-WebSocket-Key: ([^\r\n]+)/i)?.[1]
        .trim();
      if (!key) throw Error('missing WebSocket handshake');
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      process.stdout.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      );
      bytes = bytes.subarray(end + 4);
      upgraded = true;
    }
    while (bytes.length >= 2) {
      const opcode = bytes[0] & 15,
        masked = !!(bytes[1] & 128);
      let length = bytes[1] & 127,
        offset = 2;
      if (length === 126) {
        if (bytes.length < 4) return;
        length = bytes.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (bytes.length < 10) return;
        length = Number(bytes.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > 256 * 1024 * 1024) throw Error('oversized fixture frame');
      if (bytes.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? bytes.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(bytes.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      bytes = bytes.subarray(offset + length);
      if (opcode === 8) {
        write('', 8);
        input.end();
        return;
      }
      if (opcode === 9) {
        write(payload, 10);
        continue;
      }
      if (opcode !== 1) throw Error('unexpected fixture opcode');
      input.write(payload);
      input.write('\n');
    }
  });
  process.stdin.on('end', () => input.end());
  return { input, write };
}

const port = Number(process.argv[2]);
const args = process.argv.slice(3);
if (args.includes('daemon') && args.includes('start')) process.exit(0);
const agy = args.includes('acp');
if (agy && !args.includes('--dangerously-skip-permissions'))
  throw Error('agy must launch with native full permissions');
const claude = !agy && args.includes('--dangerously-skip-permissions');
let control,
  gates,
  gate,
  request,
  server,
  thread = 'native-fixture-session',
  turn = 'fixture-turn',
  promptId,
  interrupted = false;
let opened, activePlan;
let write = (text) => process.stdout.write(text + '\n');
const send = (value) => write(JSON.stringify(value));
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const event = (method, params) => send({ jsonrpc: '2.0', method, params });
const trace = (phase, extra = {}) =>
  control.write(JSON.stringify({ phase, request, pid: process.pid, ...extra }) + '\n');
async function connectControl() {
  if (control) return;
  control = connect(port, '127.0.0.1');
  await new Promise((ok, bad) => {
    control.once('connect', ok);
    control.once('error', bad);
  });
  gates = createInterface({ input: control });
  gate = gates[Symbol.asyncIterator]();
}
async function pauseInput(stage, extra = {}) {
  const marker = join(process.env.CLAUDE_CONFIG_DIR, 'fixture-input-paused');
  if (process.env.MAKA_NATIVE_FIXTURE_PAUSE_INPUT !== stage || existsSync(marker)) return;
  writeFileSync(marker, stage);
  await connectControl();
  trace(stage, extra);
  await gate.next();
}
async function mcp(method, params = {}, id = 1, signal) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      authorization: server.authorization,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal,
  });
  if (!response.ok)
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ message: `HTTP ${response.status}` }) }],
    };
  let text = await response.text();
  const value =
    text.startsWith('event:') || text.startsWith('data:')
      ? JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            .slice(5),
        )
      : JSON.parse(text);
  return (
    value.result ?? {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(value.error) }],
    }
  );
}
function output(text) {
  if (claude)
    append({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: { id: crypto.randomUUID(), content: [{ type: 'text', text }] },
    });
  else if (agy)
    event('session/update', {
      sessionId: thread,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
  else
    event('item/agentMessage/delta', {
      threadId: thread,
      turnId: turn,
      itemId: 'answer',
      delta: text,
    });
}
function terminal(cancelled = false) {
  if (claude) {
    if (!cancelled) append({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
  } else if (agy) reply(promptId, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
  else
    event('turn/completed', {
      threadId: thread,
      turn: { id: turn, status: cancelled ? 'interrupted' : 'completed' },
    });
}
async function cancel() {
  if (interrupted) return;
  interrupted = true;
  if (request?.message === 'wait-cancel-terminal') {
    trace('interrupt_requested');
    await gate.next();
  }
  if (control && !activePlan?.expectCancel) {
    if (activePlan?.earlyTerminal) trace('cancelled_tools');
    trace('terminal');
  }
  if (!activePlan?.expectCancel) terminal(true);
}
async function prompt() {
  await connectControl();
  await mcp('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'native-fixture', version: '1' },
  });
  request.tools = (await mcp('tools/list')).tools ?? [];
  trace('opened', { cwd: process.cwd() });
  let first = (await gate.next()).value,
    plan;
  try {
    plan = JSON.parse(first);
  } catch {}
  activePlan = plan;
  if (plan?.calls) {
    const calls = plan.calls.map(async (call) => {
      const signal = new AbortController();
      const work = mcp(
        'tools/call',
        { name: call.name, arguments: call.input },
        call.callId + 10,
        signal.signal,
      );
      if (plan.cancelCalls) setTimeout(() => signal.abort(), 25);
      const result = await work.catch(() => ({
        isError: true,
        content: [{ type: 'text', text: 'client cancelled' }],
      }));
      trace('tool_result', { reply: { callId: call.callId, result } });
    });
    trace('responsive');
    if (plan.earlyTerminal) {
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (interrupted) {
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
      await gate.next();
      process.exit(0);
    }
    await Promise.all(calls);
    if (plan.expectCancel) {
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (interrupted) {
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
      trace('cancelled_tools');
      trace('terminal');
      await gate.next();
      terminal(true);
      return;
    }
  }
  if (claude && request.message === 'api-error')
    append({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 400 FIXTURE_API_FAILURE' }] },
    });
  else output('committed output');
  trace('output');
  if (request.message === 'wait' || request.message === 'wait-cancel-terminal') return;
  await gate.next();
  if (request.message === 'crash' || request.message === 'exit0')
    process.exit(request.message === 'exit0' ? 0 : 3);
  if (request.message === 'malformed') {
    write('{bad json}');
    return;
  }
  if (request.message === 'pipe-holder-crash') {
    const escaped = spawn(
      process.execPath,
      [
        '-e',
        `process.stdout.on('error',()=>{});setTimeout(()=>process.exit(0),120000); setInterval(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'native-fixture-session',turnId:'fixture-turn',itemId:'x',delta:'escaped'}})+'\\n'),10)`,
      ],
      { detached: true, stdio: ['ignore', 'inherit', 'ignore'] },
    );
    await new Promise((ok) => escaped.once('spawn', ok));
    escaped.unref();
    trace('escaped', { pid: escaped.pid });
    process.exit(3);
  }
  trace('terminal');
  await gate.next();
  if (request.message === 'wrong-turn') {
    event('turn/completed', {
      threadId: thread,
      turn: { id: 'historical-turn', status: 'completed' },
    });
    process.exit(0);
  }
  if (claude && request.message === 'blocked-stop') {
    append({ type: 'system', subtype: 'stop_hook_summary' });
    output('after blocked Stop');
  }
  terminal();
}
let transcript;
function append(row) {
  appendFileSync(transcript, JSON.stringify({ sessionId: thread, ...row }) + '\n');
}
if (claude) {
  if (args.some((a) => a === '-p' || a === '--print')) throw Error('interactive PTY required');
  thread = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
  const cwd = realpathSync(process.cwd()),
    project = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const directory = join(process.env.CLAUDE_CONFIG_DIR, 'projects', project);
  mkdirSync(directory, { recursive: true });
  transcript = join(directory, thread + '.jsonl');
  server = JSON.parse(
    (await import('node:fs')).readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'),
  ).mcpServers.maka;
  server.authorization = server.headers.Authorization;
  request = { message: '', images: [], ...(args.includes('--resume') ? { resume: thread } : {}) };
  process.stdin.setRawMode(true);
  await mcp('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'native-fixture', version: '1' },
  });
  await mcp('tools/list');
  await pauseInput('startup', { cwd });
  const decoder = new StringDecoder('utf8');
  let pending = '',
    composing = '',
    trusted = !process.env.MAKA_NATIVE_FIXTURE_TRUST;
  const ready = () => process.stdout.write('Claude Code native fixture\r\n$');
  if (!trusted)
    process.stdout.write(
      'Permission Required: Accessing workspace:\r\n' +
        cwd +
        '\r\ny. Yes, I trust this folder\r\nn. No, exit\r\nEnter y/n:\r\nEnter to confirm',
    );
  else ready();
  process.stdin.on('data', async (bytes) => {
    pending += decoder.write(bytes);
    if (!trusted) {
      if (!pending.includes('y\r')) return;
      pending = pending.slice(pending.indexOf('y\r') + 2);
      trusted = true;
      writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'fixture-trusted-workspace'), cwd);
      ready();
    }
    while (pending.length) {
      if (pending.startsWith('\x1b[200~')) {
        const end = pending.indexOf('\x1b[201~');
        if (end < 0) return;
        const pasted = pending.slice(6, end);
        pending = pending.slice(end + 6);
        if (/\.(png|jpg|gif|webp)$/.test(pasted) && existsSync(pasted)) {
          const extension = pasted.split('.').at(-1);
          const mediaType = {
            png: 'image/png',
            jpg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
          }[extension];
          request.images.push({ path: pasted, mediaType });
          await pauseInput('image', { path: pasted });
          process.stdout.write('[Image #' + request.images.length + ']');
        } else {
          composing += pasted;
          await pauseInput('text');
          process.stdout.write(
            pasted.length > 4096 ? '[Pasted text #1]' : pasted.replace(/(.{1,100})\s+/g, '$1\r\n'),
          );
        }
      } else if ('\x1b[200~'.startsWith(pending)) return;
      else if (pending.startsWith('\r')) {
        pending = pending.slice(1);
        request.message = composing;
        append({
          type: 'user',
          uuid: crypto.randomUUID(),
          message: {
            content: [
              ...request.images.map((image) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: readFileSync(image.path).toString('base64'),
                },
              })),
              {
                type: 'text',
                text:
                  request.images.map((_, i) => '[Image #' + (i + 1) + ']').join(' ') +
                  request.message,
              },
            ],
          },
        });
        void prompt();
      } else if (pending.startsWith('\x1b')) {
        pending = pending.slice(1);
        void cancel();
      } else pending = pending.slice(1);
    }
  });
} else {
  const wire = agy ? { input: process.stdin, write } : websocket();
  write = wire.write;
  const lines = createInterface({ input: wire.input });
  lines.on('line', async (line) => {
    const value = JSON.parse(line),
      p = value.params ?? {},
      id = value.id,
      m = value.method;
    if (m === 'initialize') {
      reply(
        id,
        agy
          ? {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true },
                _meta: { antigravity: { systemPrompt: { append: true } } },
              },
              agentInfo: { name: 'fixture', version: '1.5.0' },
            }
          : { userAgent: 'fixture' },
      );
    } else if (m === 'initialized') {
    } else if (m === 'model/list') {
      reply(id, {
        nextCursor: p.cursor ? null : 'second-page',
        data: Array.from({ length: 10 }, (_, offset) => {
          const i = offset + (p.cursor ? 10 : 0);
          return {
            id: `external-${i}`,
            displayName: `External ${i}`,
            supportedReasoningEfforts: [{ reasoningEffort: 'vendor-deep' }],
            defaultReasoningEffort: 'vendor-deep',
          };
        }),
      });
    } else if (m === 'account/read') {
      reply(id, { account: { type: 'apiKey' } });
    } else if (['thread/start', 'thread/resume', 'session/new', 'session/load'].includes(m)) {
      opened = p;
      thread = p.threadId ?? p.sessionId ?? thread;
      const s = agy ? p.mcpServers?.[0] : p.config?.mcp_servers?.maka;
      if (s)
        server = {
          url: s.url,
          authorization: agy
            ? s.headers.find((h) => h.name === 'Authorization').value
            : s.http_headers.Authorization,
        };
      if (server && process.env.MAKA_NATIVE_PREOPEN_PROBE) {
        await mcp('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'native-fixture', version: '1' },
        });
        const premature = await mcp('tools/call', { name: '__before_identity__', arguments: {} });
        if (JSON.parse(premature.content[0].text).code !== -32600)
          throw Error('Host call admitted before native identity persistence');
      }
      if (args.includes('--hold-open')) {
        await connectControl();
        trace('before_opened');
        await gate.next();
      }
      reply(
        id,
        agy
          ? {
              sessionId: thread,
              modes: { currentModeId: 'default', availableModes: [{ id: 'yolo', name: 'YOLO' }] },
              configOptions: [
                { id: 'mode', currentValue: 'default', options: [{ value: 'yolo', name: 'YOLO' }] },
                {
                  id: 'model',
                  category: 'model',
                  currentValue: 'fixture-model',
                  options: [{ value: 'fixture-model', name: 'Fixture' }],
                },
                {
                  id: 'thought_level',
                  category: 'thought_level',
                  currentValue: 'vendor-deep',
                  options: [{ value: 'vendor-deep', name: 'Deep' }],
                },
              ],
            }
          : {
              thread: { id: thread },
              approvalPolicy: p.approvalPolicy,
              sandbox: {
                type: p.sandbox === 'danger-full-access' ? 'dangerFullAccess' : p.sandbox,
              },
              model: p.model ?? 'fixture-model',
            },
      );
    } else if (m === 'session/set_mode') {
      if (p.modeId !== 'yolo') throw Error('missing yolo');
      reply(id, {});
    } else if (m === 'session/set_config_option') {
      reply(id, {
        configOptions: [
          { id: p.configId, currentValue: p.value },
          {
            id: 'model',
            category: 'model',
            currentValue: 'fixture-model',
            options: [{ value: 'fixture-model' }],
          },
          {
            id: 'thought_level',
            category: 'thought_level',
            currentValue: 'vendor-deep',
            options: [{ value: 'vendor-deep' }],
          },
        ],
      });
    } else if (m === 'turn/start' || m === 'session/prompt') {
      if (!agy && (p.approvalPolicy !== 'never' || p.sandboxPolicy.type !== 'dangerFullAccess'))
        throw Error('missing maximum turn permission');
      promptId = id;
      request = {
        message: agy ? p.prompt[0].text : p.input[0].text,
        effort: p.effort ?? 'vendor-deep',
        images: agy
          ? []
          : p.input
              .filter((v) => v.type === 'localImage')
              .map((v) => ({ path: v.path, mediaType: 'image/png' })),
        ...(opened.threadId || opened.sessionId ? { resume: thread } : {}),
      };
      if (!agy && process.env.MAKA_NATIVE_FIXTURE_EARLY_EVENTS) {
        for (let i = 0; i < 257; i++)
          event('item/agentMessage/delta', {
            threadId: thread,
            turnId: turn,
            itemId: 'early',
            delta: i + ',',
          });
      }
      if (!agy) reply(id, { turn: { id: turn, status: 'inProgress' } });
      void prompt();
    } else if (m === 'turn/interrupt' || m === 'session/cancel') {
      if (id) reply(id, {});
      void cancel();
    } else reply(id, {});
  });
  lines.on('close', () => process.exit(0));
}
