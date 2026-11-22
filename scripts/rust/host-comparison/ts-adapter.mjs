#!/usr/bin/env node
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
// Thin controller for production TS Host at main 0d19f242336a31e8aeb300372d3d3c896b1e99ef.
// Usage: node ts-adapter.mjs --checkout PATH --root PATH --workspace PATH --provider-url http://127.0.0.1:PORT/v1
// stdin JSONL: {id,command:'setup'|'create'|'admit'|'completion'|'send'|'read'|'status'|'close'|'restart'|'exit',...}
// setup optional model; create optional sessionId/name; send requires sessionId/text, optional turnId/timeoutMs;
// read requires sessionId, optional includeRaw. close stops Host; restart reopens same durable root.
// Responses: {id,result} / {id,error}; asynchronous output: {type:'event',event,...,monoMs,wallMs}.
// Parent MUST supply a sanitized environment. All model traffic must target loopback provider.
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { diagnosticError } from './diagnostics.mjs';
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key?.startsWith('--') || !process.argv[i + 1])
    throw new Error('Expected paired --option value');
  options[key.slice(2)] = process.argv[i + 1];
}
for (const key of ['checkout', 'root', 'workspace', 'provider-url'])
  if (!options[key]) throw new Error(`Missing --${key}`);
const checkout = resolve(options.checkout),
  rootPath = resolve(options.root),
  workspace = resolve(options.workspace);
const providerUrl = new URL(options['provider-url']);
if (
  providerUrl.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(providerUrl.hostname) ||
  providerUrl.username ||
  providerUrl.password
)
  throw new Error('Provider must be unauthenticated loopback HTTP');
// Supported production initialization: prevents models.dev refresh and optional background helpers;
// production execution stores and transcript persistence remain enabled.
process.env.MAKA_HOSTED_INITIALIZATION = JSON.stringify({ incognito: true });
const client = await import(
  pathToFileURL(join(checkout, 'packages/runtime-host/dist/client/index.js')).href
);
const protocol = await import(
  pathToFileURL(join(checkout, 'packages/runtime-host/dist/protocol/index.js')).href
);
let connection, pid, hostEpoch, configured, spawnedProcess, hostStartTicks;
let connections = [],
  observers = [],
  requestedScopes = 1;
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (name, value = {}) =>
  output({ type: 'event', event: name, monoMs: performance.now(), wallMs: Date.now(), ...value });
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function startTicks(processId) {
  // This measurement adapter targets Linux. A PID alone is insufficient after a crash.
  try {
    const stat = await readFile(`/proc/${processId}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
async function ensureScopes(count) {
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new Error('scopes must be an integer from 1 to 10000');
  while (connections.length < count) {
    // Only connect to the already launched Host: additional scopes never spawn candidates.
    const connected = await client.connectExistingRuntimeHost({
      rootPath,
      protocol: {
        min: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
        max: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
      },
      compositionId: protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      clientInstanceId: randomUUID(),
    });
    if (connected.kind !== 'connected')
      throw new Error(`Additional client connection failed: ${connected.kind}`);
    if (connected.connection.hostEpoch !== hostEpoch) {
      await connected.connection.close();
      throw new Error('Additional scope attached to a different Host');
    }
    connections.push(connected.connection);
  }
  while (connections.length > count) await connections.pop().close();
  requestedScopes = count;
}
async function start(scopes = requestedScopes) {
  if (connection) {
    await ensureScopes(scopes);
    return status();
  }
  process.env.MAKA_HOSTED_INITIALIZATION = JSON.stringify({ incognito: true });
  const connected = await client.connectOrSpawnRuntimeHost({
    rootPath,
    protocol: {
      min: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
      max: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: pathToFileURL(
      join(checkout, 'packages/runtime-host/dist/execution-candidate-main.js'),
    ),
    clientInstanceId: randomUUID(),
    candidateExecutable: process.execPath,
    idleGraceMs: 120_000,
    electionDeadlineMs: 120_000,
    onExit: (details) => event('host-exit', details),
  });
  if (connected.kind !== 'connected')
    throw new Error(`Host connection failed: ${JSON.stringify(connected)}`);
  connection = connected.connection;
  connections = [connection];
  spawnedProcess = connected.spawnedProcess;
  const deadline = performance.now() + 120_000;
  while ((await connection.status()).state !== 'ready') {
    if (performance.now() > deadline) throw new Error('Host readiness timeout');
    await pause(25);
  }
  const diagnostic = await connection.request('host.diagnostics.query', {});
  pid = diagnostic.pid;
  hostEpoch = diagnostic.hostEpoch;
  hostStartTicks = await startTicks(pid);
  if (hostStartTicks === null) throw new Error('Host exited before process ownership was captured');
  await ensureScopes(scopes);
  // Expose authoritative production PID, never the adapter PID. No diagnostics logs on stdout.
  const result = {
    pid,
    hostEpoch,
    state: diagnostic.state,
    nodeVersion: diagnostic.nodeVersion,
    platform: diagnostic.platform,
    scopeCount: connections.length,
    adapterPid: process.pid,
    spawnedPid: spawnedProcess?.pid,
  };
  event('host-ready', result);
  return result;
}
async function status() {
  if (!connection) return { connected: false, pid, hostEpoch, scopeCount: 0 };
  return {
    ...(await connection.status()),
    pid,
    scopeCount: connections.length,
    adapterPid: process.pid,
  };
}
async function setup(input) {
  const started = await start(input.scopes ?? 1);
  const model = input.model ?? 'comparison-model';
  const catalog = await client.readRuntimeHostConnectionCatalog(connection);
  let target = catalog.connections.find((item) => item.slug === 'offline-comparison');
  if (target) {
    if (target.providerType !== 'custom' || target.defaultApiProtocol !== 'openai-chat-completions')
      throw new Error('Existing comparison connection type differs');
    const updated = await connection.request('connection.catalog.update', {
      expected: { connectionId: target.connectionId, revision: target.revision },
      changes: {
        name: 'Offline comparison',
        baseUrl: providerUrl.href,
        enabled: true,
        enabledModelIds: [model],
        modelOverrides: { [model]: { contextWindow: 2000000 } },
      },
    });
    if (updated.kind !== 'committed') throw new Error(`Connection update: ${updated.kind}`);
  } else {
    const created = await connection.request('connection.catalog.create', {
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'offline-comparison',
        name: 'Offline comparison',
        providerType: 'custom',
        defaultApiProtocol: 'openai-chat-completions',
        baseUrl: providerUrl.href,
        enabled: true,
        enabledModelIds: [model],
        modelOverrides: { [model]: { contextWindow: 2000000 } },
      },
    });
    if (created.kind !== 'committed') throw new Error(`Connection create: ${created.kind}`);
    target = created.connection;
    const credential = await connection.request('credential.vault.set', {
      locator: { scope: 'connection', connectionId: target.connectionId, kind: 'api_key' },
      expected: null,
      secret: 'offline-comparison-dummy',
    });
    if (credential.kind !== 'committed')
      throw new Error(`Dummy credential setup: ${credential.kind}`);
  }
  configured = { connectionId: target.connectionId, connectionSlug: 'offline-comparison', model };
  return { ...started, target: configured, providerUrl: providerUrl.href };
}
function requireConnection(input) {
  if (!connection) throw new Error('Run setup or restart first');
  const index = input.client ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= connections.length)
    throw new Error('Invalid client scope index');
  return connections[index];
}
async function observe() {
  if (!connection) throw new Error('Run setup before observe');
  if (observers.length) throw new Error('Observer scopes already connected');
  const startedMs = performance.now();
  for (let index = 0; index < requestedScopes; index++) {
    const connected = await client.connectExistingRuntimeHost({
      rootPath,
      protocol: {
        min: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
        max: protocol.RUNTIME_HOST_PROTOCOL_VERSION,
      },
      compositionId: protocol.INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      clientInstanceId: randomUUID(),
      handshakeTimeoutMs: 120_000,
    });
    if (connected.kind !== 'connected')
      throw new Error(
        `Observer connection failed: ${JSON.stringify({ kind: connected.kind, reason: connected.reason, connectionFailure: connected.connectionFailure })}`,
      );
    if (connected.connection.hostEpoch !== hostEpoch) {
      await connected.connection.close();
      throw new Error('Observer attached to a different Host epoch');
    }
    observers.push(connected.connection);
  }
  return {
    senderScopes: connections.length,
    observerScopes: observers.length,
    hostEpoch,
    handshakeTimeoutMsPerScope: 120_000,
    elapsedMs: performance.now() - startedMs,
  };
}
function observationConnection(input) {
  if (!input.observer) return requireConnection(input);
  const index = input.client ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= observers.length)
    throw new Error('Invalid observer scope index');
  return observers[index];
}
async function create(input) {
  const scoped = requireConnection(input);
  if (!configured) throw new Error('Run setup before create');
  if (!input.sessionId) throw new Error('create requires explicit sessionId');
  const sessionId = input.sessionId;
  const result = await scoped.request('session.create', {
    sessionId,
    workspace: { kind: 'host_path', path: workspace },
    name: input.name ?? `comparison-${sessionId}`,
    modelTarget: { kind: 'explicit', ...configured },
  });
  return { sessionId: result.id, session: result };
}
// Admission and observation are separate public RPCs: no UI subscription or hidden queue.
async function admit(input) {
  const scoped = requireConnection(input);
  if (!input.sessionId || typeof input.text !== 'string')
    throw new Error('admit requires sessionId and text');
  const turnId = input.turnId ?? randomUUID(),
    startedMs = performance.now();
  const admission = await scoped.request(
    'turn.start',
    {
      sessionId: input.sessionId,
      turnId,
      content: { text: input.text },
    },
    input.timeoutMs ?? 120_000,
  );
  const admittedMs = performance.now();
  return {
    sessionId: input.sessionId,
    turnId,
    client: input.client ?? 0,
    admission,
    startedMs,
    admittedMs,
    elapsedMs: admittedMs - startedMs,
  };
}
async function completion(input) {
  const scoped = observationConnection(input);
  if (!input.sessionId || !input.turnId)
    throw new Error('completion requires sessionId and turnId');
  const startedMs = performance.now();
  // main protocol/turn.ts TurnQueryInput; HostTurnControlCoordinator reads admitted execution.
  const rootTurn = await scoped.request(
    'turn.query',
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    input.timeoutMs ?? 120_000,
  );
  const finishedMs = performance.now();
  if (rootTurn.sessionId !== input.sessionId || rootTurn.turnId !== input.turnId)
    throw new Error('Turn query identity mismatch');
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    client: input.client ?? 0,
    status: rootTurn.status,
    terminal: ['completed', 'failed', 'cancelled'].includes(rootTurn.status),
    rootTurn,
    startedMs,
    finishedMs,
    elapsedMs: finishedMs - startedMs,
  };
}
async function send(input) {
  const scoped = requireConnection(input);
  if (typeof input.text !== 'string' || !input.sessionId)
    throw new Error('send requires sessionId and text');
  const { sessionId } = input,
    turnId = input.turnId ?? randomUUID(),
    startedMs = performance.now();
  const sub = await scoped.openSessionSubscription({ sessionId, transcript: { kind: 'none' } });
  const texts = new Map();
  let firstTextMs = null,
    terminalMs = null,
    terminal;
  let resolveTerminal, rejectTerminal;
  const done = new Promise((yes, no) => {
    resolveTerminal = yes;
    rejectTerminal = no;
  });
  done.catch(() => {}); // The reader can fail while turn.start is still in flight.
  const consume = (async () => {
    try {
      for await (const frame of sub) {
        const now = performance.now();
        if (
          frame.kind === 'subscription.session_delta' &&
          frame.delta.turnId === turnId &&
          frame.delta.kind === 'text'
        ) {
          const delta = frame.delta,
            old = texts.get(delta.messageId) ?? '';
          if (
            !Number.isInteger(delta.startOffset) ||
            delta.startOffset < 0 ||
            (!delta.reset && delta.startOffset > old.length)
          )
            throw new Error('Invalid stream offset');
          const base = delta.reset ? '' : old;
          texts.set(delta.messageId, base.slice(0, delta.startOffset) + delta.text);
          if (delta.text.length && firstTextMs === null) firstTextMs = now;
          if (input.emitEvents)
            event('text', {
              sessionId,
              turnId,
              client: input.client ?? 0,
              messageId: delta.messageId,
              startOffset: delta.startOffset,
              utf8Bytes: Buffer.byteLength(delta.text),
              reset: !!delta.reset,
              complete: !!delta.complete,
              receivedMs: now,
            });
        }
        if (frame.kind === 'subscription.session_projection') {
          const turn = frame.snapshot.rootTurn;
          if (
            turn?.turnId === turnId &&
            ['completed', 'failed', 'cancelled'].includes(turn.status)
          ) {
            terminal = turn;
            terminalMs = now;
            if (input.emitEvents) event('terminal', { sessionId, turnId, turn, receivedMs: now });
            resolveTerminal();
            return;
          }
        }
      }
      if (!terminal) rejectTerminal(new Error('Subscription ended before terminal projection'));
    } catch (error) {
      rejectTerminal(error);
    }
  })();
  let timer;
  try {
    await sub.ready();
    const admission = await scoped.request('turn.start', {
      sessionId,
      turnId,
      content: { text: input.text },
    });
    const admittedMs = performance.now();
    if (input.emitEvents) event('admitted', { sessionId, turnId, admittedMs, admission });
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Turn terminal timeout')),
          input.timeoutMs ?? 120_000,
        );
      }),
    ]);
    const text = [...texts.values()].join('');
    return {
      sessionId,
      turnId,
      admission,
      terminal,
      startedMs,
      admittedMs,
      firstTextMs,
      terminalMs,
      text,
      utf8Bytes: Buffer.byteLength(text),
      sha256: hash(text),
    };
  } finally {
    clearTimeout(timer);
    await sub.close();
    await consume;
  }
}
async function read(input) {
  const scoped = observationConnection(input);
  if (!input.sessionId) throw new Error('read requires sessionId');
  const startedMs = performance.now();
  // Every read uses a fresh subscription: loadTranscript memoization never crosses rounds.
  const sub = await scoped.openSessionSubscription({
    sessionId: input.sessionId,
    transcript: { kind: 'tail', maxBytes: input.tailBytes ?? 16 * 1024 },
  });
  try {
    const openedMs = performance.now();
    const tail = await sub.decodeTranscriptPage(sub.transcriptBootstrap.durable, (value) => value);
    const tailDecodedMs = performance.now();
    const raw = await sub.loadTranscript((value) => value);
    const finishedMs = performance.now();
    const messages = raw
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .map((message) => {
        if (typeof message.text !== 'string')
          throw new Error('Canonical conversation row has no text');
        // Canonical original prompt is message.text; do not replace with displayText or trim output.
        return { role: message.type, text: message.text };
      });
    const assistantText = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.text)
      .join('');
    return {
      sessionId: input.sessionId,
      startedMs,
      openedMs,
      tailDecodedMs,
      finishedMs,
      tailRawBytes: sub.transcriptBootstrap.durable.rawBytes,
      tailMessages: tail.messages.length,
      canonicalRows: raw.length,
      messages,
      assistantUtf8Bytes: Buffer.byteLength(assistantText),
      assistantSha256: hash(assistantText),
      ...(input.includeRaw ? { raw } : {}),
    };
  } finally {
    await sub.close();
  }
}
async function close() {
  if (!connection) return { closed: true, pid };
  const oldConnections = [...connections, ...observers],
    oldPid = pid,
    oldEpoch = hostEpoch;
  // PID obtained through the authenticated diagnostics operation above; SIGTERM runs production drain.
  await Promise.all(oldConnections.map((scope) => scope.close()));
  connection = undefined;
  connections = [];
  observers = [];
  if ((await startTicks(oldPid)) !== hostStartTicks) {
    spawnedProcess = undefined;
    event('host-closed', { pid: oldPid, hostEpoch: oldEpoch, alreadyExited: true });
    return { closed: true, pid: oldPid, hostEpoch: oldEpoch, alreadyExited: true };
  }
  process.kill(oldPid, 'SIGTERM');
  const deadline = performance.now() + 30_000;
  if (spawnedProcess?.pid === oldPid) {
    let exitTimer;
    try {
      await Promise.race([
        spawnedProcess.exited,
        new Promise((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error('Host did not exit after SIGTERM')),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
  } else {
    while (true) {
      if ((await startTicks(oldPid)) !== hostStartTicks) break;
      if (performance.now() > deadline) throw new Error('Host did not exit after SIGTERM');
      await pause(25);
    }
  }
  spawnedProcess = undefined;
  event('host-closed', { pid: oldPid, hostEpoch: oldEpoch });
  return { closed: true, pid: oldPid, hostEpoch: oldEpoch };
}
const commands = {
  setup,
  create,
  admit,
  completion,
  send,
  read,
  status,
  observe,
  close,
  restart: async () => {
    await close();
    return start();
  },
};
event('adapter-ready', { adapterPid: process.pid, checkout, rootPath, workspace });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
let stopping = false;
async function dispatch(input) {
  if (stopping) throw new Error('Adapter is stopping');
  if (['close', 'restart', 'exit', 'setup', 'observe'].includes(input.command) && pending.size > 0)
    throw new Error('Lifecycle command requires other commands to finish');
  if (input.command === 'exit') {
    stopping = true;
    const result = await close();
    lines.close();
    return result;
  }
  const command = commands[input.command];
  if (!command) throw new Error(`Unknown command: ${input.command}`);
  return command(input);
}
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let input;
    try {
      input = JSON.parse(line);
    } catch (error) {
      output({ id: null, error: diagnosticError(error) });
      continue;
    }
    // Dispatch without awaiting: each session owns its own subscription and completion promise.
    const task = dispatch(input).then(
      (result) => output({ id: input.id, result }),
      (error) => output({ id: input.id, error: diagnosticError(error) }),
    );
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
} finally {
  await close().catch((error) =>
    process.stderr.write(`Host cleanup: ${JSON.stringify(diagnosticError(error))}\n`),
  );
}
