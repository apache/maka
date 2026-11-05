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
import { dirname, join } from 'node:path';
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
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (args.includes('models')) {
  const models = [
    ['gemini-4-argon-medium', 'Gemini 4 Argon（中）'],
    ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
    ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
    ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
    ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
    ['claude-opus-5-5-low', 'Claude Opus 5.5 · 低'],
    ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
    ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
    ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)'],
    ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)'],
    ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B（中）'],
  ];
  process.stdout.write(models.map((row) => row.join('\t')).join('\n') + '\n');
  process.exit(0);
}
const agy = args.includes('--print=') && option('--input-format') === 'stream-json';
if (args.includes('acp')) throw Error('agy requires native stream-json, not ACP');
if (
  agy &&
  (!args.includes('--dangerously-skip-permissions') || option('--output-format') !== 'stream-json')
)
  throw Error('agy requires native full permissions and stream-json output');
const claude = !agy && args.includes('--dangerously-skip-permissions');
let control,
  gates,
  gate,
  request,
  server,
  thread = 'native-fixture-session',
  turn = 'fixture-turn',
  interrupted = false;
let opened, activePlan, instructionMessage;
const instructionOrder = [];
let agyStep = 0,
  agyTurns = 0,
  agyResponse = '',
  agyBootstrapped = false,
  catalogTools = [];
const instructionMessageText = (text) =>
  text.startsWith('<maka_system_instructions>') && text.endsWith('</maka_system_instructions>');
function agyUser() {
  agyResponse = '';
  send({
    event: 'step_update',
    step_update: {
      conversation_id: thread,
      step_index: agyStep++,
      state: 'DONE',
      step_type: 'user_input',
    },
  });
}
function agyInput(text) {
  const manifest = text.match(
    /^([\s\S]*)\n\n<maka_image_attachments>\n([\s\S]*)\n<\/maka_image_attachments>$/,
  );
  if (!manifest) return { message: text, images: [], nativeMessage: text };
  const images = JSON.parse(manifest[2]);
  if (
    !Array.isArray(images) ||
    images.some((image) => typeof image.path !== 'string' || typeof image.mediaType !== 'string')
  )
    throw Error('invalid native image path manifest');
  return { message: manifest[1], images, nativeMessage: text };
}
const queuedInputs = [];
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
      content: [
        {
          type: 'text',
          text: JSON.stringify({ message: `HTTP ${response.status}` }),
        },
      ],
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
  else if (agy) {
    agyResponse += text;
    send({
      event: 'step_update',
      step_update: {
        conversation_id: thread,
        step_index: agyStep++,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: text,
      },
    });
  } else
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
  } else if (agy)
    send({
      event: 'result',
      result: {
        conversation_id: thread,
        status: cancelled ? 'ERROR' : 'SUCCESS',
        response: agyResponse,
        num_turns: ++agyTurns,
        ...(cancelled ? { error: 'interrupted', finished_reason: 'interrupted' } : {}),
      },
    });
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
if (agy)
  process.on('SIGINT', async () => {
    if (interrupted) return;
    interrupted = true;
    const held =
      request?.message === 'soft-interrupt' || request?.message === 'soft-interrupt-unconfirmed';
    if (held) {
      trace('interrupt_requested');
      await gate.next();
    }
    if (request?.message !== 'soft-interrupt-unconfirmed') terminal(true);
    if (held) {
      trace('terminal');
      await gate.next();
    }
    process.exit(1);
  });
async function loadTools() {
  await mcp('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'native-fixture', version: '1' },
  });
  return (await mcp('tools/list')).tools ?? [];
}
async function preopenProbe() {
  if (!server || !process.env.MAKA_NATIVE_PREOPEN_PROBE) return;
  await mcp('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'native-fixture', version: '1' },
  });
  const premature = await mcp('tools/call', {
    name: '__before_identity__',
    arguments: {},
  });
  if (JSON.parse(premature.content[0].text).code !== -32600)
    throw Error('Host call admitted before native identity persistence');
}
async function prompt() {
  await connectControl();
  request.tools = agy ? catalogTools : await loadTools();
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
      message: {
        content: [{ type: 'text', text: 'API Error: 400 FIXTURE_API_FAILURE' }],
      },
    });
  else output('committed output');
  trace('output');
  if (agy && request.message.startsWith('soft-interrupt')) {
    await new Promise(() => {});
    return;
  }
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
    if (agy) {
      send({
        event: 'result',
        result: {
          conversation_id: 'historical-native-session',
          status: 'SUCCESS',
          response: 'unrelated result',
          num_turns: ++agyTurns,
        },
      });
      process.exit(0);
    }
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
  for (const input of queuedInputs.splice(0)) {
    appendUser(input);
    output('steering: ' + input.message + ';');
    terminal();
  }
}
let transcript;
function appendUser(input) {
  append({
    type: 'user',
    uuid: crypto.randomUUID(),
    message: {
      content: [
        ...input.images.map((image) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: readFileSync(image.path).toString('base64'),
          },
        })),
        {
          type: 'text',
          text: input.images.map((_, i) => '[Image #' + (i + 1) + ']').join(' ') + input.message,
        },
      ],
    },
  });
}
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
  request = {
    message: '',
    images: [],
    ...(args.includes('--resume') ? { resume: thread } : {}),
  };
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
    images = [],
    submitted = false,
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
          images.push({ path: pasted, mediaType });
          await pauseInput('image', { path: pasted });
          process.stdout.write('[Image #' + images.length + ']');
        } else {
          composing += pasted;
          if (!instructionMessageText(pasted)) await pauseInput('text');
          process.stdout.write(
            pasted.length > 4096 ? '[Pasted text #1]' : pasted.replace(/(.{1,100})\s+/g, '$1\r\n'),
          );
        }
      } else if ('\x1b[200~'.startsWith(pending)) return;
      else if (pending.startsWith('\r')) {
        pending = pending.slice(1);
        const input = { message: composing, images };
        composing = '';
        images = [];
        process.stdout.write('\r\n$');
        if (!submitted && !instructionMessage && instructionMessageText(input.message)) {
          if (input.images.length)
            throw Error('instructions must be a standalone ordinary message');
          instructionMessage = input.message;
          instructionOrder.push('user/instructions');
          appendUser(input);
          output('instructions acknowledged');
          terminal();
          ready();
          continue;
        }
        if (submitted) {
          queuedInputs.push(input);
          trace('steered', { request: input, thread, turn });
        } else {
          instructionOrder.push('user/task');
          request = {
            ...request,
            ...input,
            ...(instructionMessage ? { instructions: instructionMessage } : {}),
            instructionOrder: [...instructionOrder],
          };
          submitted = true;
          appendUser(input);
          void prompt();
        }
      } else if (pending.startsWith('\x1b')) {
        pending = pending.slice(1);
        void cancel();
      } else pending = pending.slice(1);
    }
  });
} else if (agy) {
  const roots = args.flatMap((arg, index) => (arg === '--add-dir' ? [args[index + 1]] : []));
  const config = roots
    .map((root) => join(root, '.agents/plugins/maka/mcp_config.json'))
    .find(existsSync);
  if (!config) throw Error('agy requires its private native MCP plugin');
  const plugin = JSON.parse(readFileSync(join(dirname(config), 'plugin.json'), 'utf8'));
  if (plugin.name !== 'maka') throw Error('missing native plugin manifest');
  server = JSON.parse(readFileSync(config, 'utf8')).mcpServers.maka;
  server.authorization = server.headers.Authorization;
  const settings = JSON.parse(readFileSync(option('--settings'), 'utf8'));
  if (settings.queuedMessages !== 'send-immediately')
    throw Error('missing per-invocation queued-message setting');
  opened = {
    model: option('--model') ?? 'fixture-model',
    effort: option('--effort') ?? 'vendor-deep',
  };
  const resumed = option('--conversation');
  if (resumed) {
    thread = resumed;
    agyStep = 80;
    agyTurns = 40;
  }
  await preopenProbe();
  if (args.includes('--hold-open')) {
    await connectControl();
    trace('before_opened');
    await gate.next();
  }
  send({
    event: 'init',
    conversation_id: thread,
    init: {
      model: opened.model,
      permission_mode: process.env.MAKA_NATIVE_FIXTURE_LOW_PERMISSION
        ? 'request-review'
        : 'always-proceed',
      cwd: process.cwd(),
      tools: ['read_file', 'run_command', 'call_mcp_tool'],
    },
  });
  const lines = createInterface({ input: process.stdin });
  let work = Promise.resolve();
  lines.on('line', (line) => {
    work = work.then(async () => {
      const value = JSON.parse(line);
      if (value.event !== 'user' || typeof value.message?.content !== 'string')
        throw Error('agy requires native ordinary user messages');
      const text = value.message.content;
      if (!agyBootstrapped) {
        const readiness =
          'Initialize the available MCP tool catalog for this conversation and acknowledge readiness. Do not perform a user task yet.';
        if (!instructionMessageText(text) && text !== readiness)
          throw Error('the user task cannot stand in for the standalone agy bootstrap');
        instructionMessage = instructionMessageText(text) ? text : undefined;
        instructionOrder.push(instructionMessage ? 'user/instructions' : 'user/bootstrap');
        agyUser();
        catalogTools = await loadTools();
        if (process.env.MAKA_NATIVE_FIXTURE_BOOTSTRAP_TOOL) {
          const index = agyStep++;
          for (const state of ['ACTIVE', 'DONE']) {
            send({
              event: 'step_update',
              step_update: {
                conversation_id: thread,
                step_index: index,
                state,
                step_type: 'tool',
                tool_name: 'bootstrap-native',
                tool_info: { name: 'bootstrap-native', parameters: {} },
              },
            });
          }
        }
        if (process.env.MAKA_NATIVE_FIXTURE_BOOTSTRAP_TOOL) {
          for (const serverName of ['maka_maka', 'maka']) {
            const index = agyStep++;
            for (const state of ['ACTIVE', 'DONE']) {
              send({
                event: 'step_update',
                step_update: {
                  conversation_id: thread,
                  step_index: index,
                  state,
                  step_type: 'tool',
                  tool_name: 'call_mcp_tool',
                  tool_info: {
                    name: 'call_mcp_tool',
                    parameters: { ServerName: serverName, ToolName: 'probe', Arguments: {} },
                    ...(serverName === 'maka' && state === 'DONE'
                      ? { error: { type: 'TOOL_ERROR', message: 'native global tool failure' } }
                      : {}),
                  },
                },
              });
            }
          }
        }
        output('instructions acknowledged');
        terminal();
        agyBootstrapped = true;
        return;
      }
      instructionOrder.push('user/task');
      request = {
        ...agyInput(text),
        model: opened.model,
        effort: opened.effort,
        ...(resumed ? { resume: thread } : {}),
        ...(instructionMessage ? { instructions: instructionMessage } : {}),
        instructionOrder: [...instructionOrder],
      };
      agyUser();
      await prompt();
    });
    work.catch((error) => {
      throw error;
    });
  });
  lines.on('close', () => process.exit(0));
} else {
  const wire = websocket();
  write = wire.write;
  const lines = createInterface({ input: wire.input });
  lines.on('line', async (line) => {
    const value = JSON.parse(line),
      p = value.params ?? {},
      id = value.id,
      m = value.method;
    if (
      ['thread/start', 'thread/resume', 'turn/start'].includes(m) &&
      ('developerInstructions' in p || 'baseInstructions' in p)
    )
      throw Error('native system instructions must remain unchanged');
    if (m === 'initialize') {
      reply(id, { userAgent: 'fixture' });
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
    } else if (m === 'thread/start' || m === 'thread/resume') {
      opened = p;
      thread = p.threadId ?? thread;
      instructionOrder.push(m);
      const config = p.config?.mcp_servers?.maka;
      if (config)
        server = {
          url: config.url,
          authorization: config.http_headers.Authorization,
        };
      await preopenProbe();
      if (args.includes('--hold-open')) {
        await connectControl();
        trace('before_opened');
        await gate.next();
      }
      reply(id, {
        thread: { id: thread },
        approvalPolicy: p.approvalPolicy,
        sandbox: {
          type: p.sandbox === 'danger-full-access' ? 'dangerFullAccess' : p.sandbox,
        },
        model: p.model ?? 'fixture-model',
      });
    } else if (m === 'thread/inject_items') {
      const item = p.items?.[0],
        content = item?.content;
      if (
        !opened ||
        p.threadId !== thread ||
        p.items.length !== 1 ||
        item.type !== 'message' ||
        item.role !== 'user' ||
        content?.length !== 1 ||
        content[0].type !== 'input_text' ||
        !instructionMessageText(content[0].text) ||
        request
      )
        throw Error(
          'instructions must be injected as an independent ordinary user message before the turn',
        );
      instructionMessage = content[0].text;
      instructionOrder.push(m);
      reply(id, {});
    } else if (m === 'turn/steer') {
      if (p.threadId !== thread || p.expectedTurnId !== turn)
        throw Error('steering must target the active native turn');
      const input = {
        message: p.input[0].text,
        images: p.input
          .filter((v) => v.type === 'localImage')
          .map((v) => ({ path: v.path, mediaType: 'image/png' })),
      };
      trace('steered', { request: input, thread, turn });
      if (input.message === 'finish-before-steer') {
        output('finished before steering');
        terminal();
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'No active turn for expectedTurnId' },
        });
        return;
      }
      // A normal live delta may precede the acknowledgement and must not disappear.
      output('steering: ' + input.message + ';');
      reply(id, {
        turnId: input.message === 'wrong-steer-ack' ? 'unrelated-turn' : turn,
      });
    } else if (m === 'turn/start') {
      if (p.approvalPolicy !== 'never' || p.sandboxPolicy.type !== 'dangerFullAccess')
        throw Error('missing maximum turn permission');
      instructionOrder.push(m);
      request = {
        message: p.input[0].text,
        effort: p.effort ?? 'vendor-deep',
        images: p.input
          .filter((v) => v.type === 'localImage')
          .map((v) => ({ path: v.path, mediaType: 'image/png' })),
        ...(opened.threadId ? { resume: thread } : {}),
        ...(instructionMessage ? { instructions: instructionMessage } : {}),
        instructionOrder: [...instructionOrder],
      };
      if (process.env.MAKA_NATIVE_FIXTURE_EARLY_EVENTS) {
        for (let i = 0; i < 257; i++)
          event('item/agentMessage/delta', {
            threadId: thread,
            turnId: turn,
            itemId: 'early',
            delta: i + ',',
          });
      }
      reply(id, { turn: { id: turn, status: 'inProgress' } });
      void prompt();
    } else if (m === 'turn/interrupt') {
      if (id) reply(id, {});
      void cancel();
    } else throw Error('unsupported native fixture method: ' + m);
  });
  lines.on('close', () => process.exit(0));
}
