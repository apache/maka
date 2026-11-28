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

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { text as consumeText } from 'node:stream/consumers';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { killProcessGroup, runMonitoredProcess } from './proc-monitor.mjs';
import { parseBenchmarkCommand, replaceUnique, resolveWorkspaceFile } from './fixtures.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(script), '../..');
const chat = 'openai-chat-completions';
const anthropic = 'anthropic-messages';
const responses = 'openai-responses-http';
const websockets = 'openai-responses-ws';
const native = Object.freeze(['native']);
const both = Object.freeze(['native', 'sharedMcp']);
const makaIsolation = 'Maka requires a disposable OS account or container. Set HARNESS_BENCH_MAKA_ACCOUNT_HOME to that account home.';
const toml = value => JSON.stringify(value);

async function privateFile(path, content, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const file = await open(path, flags, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(content, 'utf8');
  } finally {
    await file.close();
  }
}

function jsonFile(path, value) {
  return privateFile(path, JSON.stringify(value, null, 2) + '\n');
}

async function isolatedEnv(directory, source, tempDirs) {
  const dirs = Object.fromEntries([
    ['HOME', 'home'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'],
    ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'], ['XDG_RUNTIME_DIR', 'runtime'],
    ['TMPDIR', 'tmp'], ['APPDATA', 'app-data'], ['LOCALAPPDATA', 'local-app-data'],
  ].map(([name, leaf]) => [name, join(directory, leaf)]));
  if (tempDirs && process.platform === 'darwin' && dirs.TMPDIR.length > 48) {
    dirs.TMPDIR = await mkdtemp('/tmp/hb-');
    tempDirs.add(dirs.TMPDIR);
  }
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const path = (source.PATH ?? source.Path ?? '/usr/bin:/bin').split(delimiter)
    .filter(isAbsolute).join(delimiter);
  return {
    ...dirs, PATH: path, USERPROFILE: dirs.HOME, TMP: dirs.TMPDIR, TEMP: dirs.TMPDIR,
    LC_ALL: 'C', TERM: 'dumb', CI: '1', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirs.HOME, '.gitconfig'),
    ...(process.platform === 'win32' ? { SystemRoot: source.SystemRoot, ComSpec: source.ComSpec } : {}),
  };
}

async function findBinary(name, env, repoRoot) {
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  const explicit = name === 'maka' ? env.MAKA_BENCH_BINARY : undefined;
  const cargoTarget = resolve(repoRoot, env.CARGO_TARGET_DIR ?? 'target');
  const searchDirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute);
  const dirs = name === 'maka' ? [join(cargoTarget, 'release'), ...searchDirs] : searchDirs;
  const candidates = explicit ? [resolve(explicit)]
    : dirs.flatMap(dir => suffixes.map(suffix => join(dir, name + suffix)));
  for (const file of candidates) {
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return undefined;
}

function scopedUrl(origin, run, session) {
  const url = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !['http:', 'https:'].includes(url.protocol) || url.href !== url.origin + '/') {
    throw new Error('scopedOrigin must be a bare loopback HTTP(S) origin');
  }
  const path = '/s/' + run + '/' + session;
  if ([run, session].some(id => typeof id !== 'string' || !id || /[/?#\\]/.test(id))
      || new URL(path, url).pathname !== path) {
    throw new Error('Expected raw mock-ai run and session path IDs');
  }
  return url.origin + path;
}

function mcpServer({ mcpServerCmd, mcpAuditPath, workspace, resumeAfterKill }) {
  if (!mcpAuditPath) throw new Error('sharedMcp requires mcpAuditPath');
  let command;
  let args;
  if (mcpServerCmd === undefined) {
    command = process.execPath;
    args = [join(dirname(script), 'mcp-server.mjs')];
  } else if (Array.isArray(mcpServerCmd)) {
    [command, ...args] = mcpServerCmd;
  } else if (typeof mcpServerCmd === 'string') {
    command = mcpServerCmd.endsWith('.mjs') ? process.execPath : mcpServerCmd;
    args = mcpServerCmd.endsWith('.mjs') ? [mcpServerCmd] : [];
  } else {
    ({ command, args = [] } = mcpServerCmd);
  }
  if (!command || !Array.isArray(args)) throw new Error('Invalid MCP server command');
  return {
    command,
    args: [...args, '--workspace', workspace, '--audit-log', resolve(mcpAuditPath),
      ...(resumeAfterKill ? ['--resume-audit'] : [])],
  };
}

function adapter({ id, harness = id, binary = harness, protocol = chat, supportedTracks = native,
  defaultModel = 'gpt-4.1', installHint, versionArgs = ['--version'], prepare, start, shared, batch, locate, version }) {
  const commandPath = locate ?? ((env, repoRoot) => findBinary(binary, env, repoRoot));
  const launchMode = shared || batch ? 'shared-daemon' : start ? 'warm-daemon' : 'cold';
  const requireCommand = async (env, repoRoot) => {
    const command = await commandPath(env, repoRoot);
    if (!command) throw new Error(`${id}: could not locate ${binary}. ${installHint}`);
    return command;
  };
  async function context(options) {
    const { track, env: source = process.env } = options;
    if (!supportedTracks.includes(track)) {
      throw new Error(`${id} does not support track ${JSON.stringify(track)}`);
    }
    if (!options.apiKey) throw new Error(`${id} requires a mock API key`);
    const model = options.model ?? defaultModel;
    if (typeof model !== 'string' || !model.trim()) throw new Error(`${id} requires a model ID`);
    const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
    const base = scopedUrl(options.scopedOrigin, options.runId, options.sessionId);
    const isolatedDir = resolve(options.isolatedDir);
    const workspace = await realpath(options.workspace);
    const command = await requireCommand(source, repoRoot);
    if (harness === 'maka' && source.HARNESS_BENCH_MAKA_ACCOUNT_HOME !== userInfo().homedir) {
      throw new Error(makaIsolation);
    }
    const env = await isolatedEnv(isolatedDir, source, options.tempDirs);
    const mcp = track === 'sharedMcp' ? mcpServer({ ...options, workspace }) : undefined;
    return { ...options, model, base, v1: base + '/v1', isolatedDir, workspace, repoRoot, source, command, env, mcp };
  }
  return Object.freeze({
    id, harness, protocol, launchMode, supportedTracks, defaultModel, shared: shared ?? (batch ? supportedTracks : []),
    async probe({ env = process.env, repoRoot = defaultRepoRoot } = {}) {
      const result = { id, available: false, installHint };
      let scratch;
      try {
        const binaryPath = await requireCommand(env, repoRoot);
        result.binaryPath = binaryPath;
        if (harness === 'maka' && env.HARNESS_BENCH_MAKA_ACCOUNT_HOME !== userInfo().homedir) {
          return { ...result, reason: makaIsolation };
        }
        scratch = await mkdtemp(join(tmpdir(), 'harness-probe-'));
        const invocation = { cwd: scratch, env: await isolatedEnv(scratch, env), timeout: 8_000 };
        const detected = version ? await version(env, repoRoot, invocation)
          : (({ stdout, stderr }) => (stdout || stderr).trim())(
            await exec(binaryPath, versionArgs, invocation));
        if (!detected) return { ...result, reason: 'Version command returned an empty version' };
        return { ...result, available: true, version: detected };
      } catch (error) {
        return { ...result, reason: error.message };
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    },
    ...(prepare ? { async prepareInvocation(options) {
      const ctx = await context(options);
      return { command: ctx.command, cwd: ctx.workspace, env: ctx.env, ...await prepare(ctx) };
    } } : {}),
    ...(start ? {
      async startDaemon(options, lanes) {
        return start(await context(options), lanes?.map(lane => ({
          ...lane, model: lane.model ?? defaultModel,
          v1: scopedUrl(lane.scopedOrigin, lane.runId, lane.sessionId) + '/v1',
        })));
      },
      stopDaemon,
    } : {}),
    ...(batch ? { async prepareBatch(options, lanes) {
      const ctx = await context(options);
      return { command: ctx.command, cwd: ctx.workspace, env: ctx.env, ...await batch(ctx, lanes) };
    } } : {}),
  });
}

async function startChild(command, args, { env, workspace, monitor, abortBatch }, ready) {
  monitor?.signal.throwIfAborted();
  const child = spawn(command, args, {
    env, cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const observation = monitor?.watch(child.pid);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.once('exit', () => {
    if (monitor) monitor.release(observation);
    else killProcessGroup(child.pid);
  });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const state = { child, exited, monitor, observation };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const signal = monitor?.signal;
  let timer;
  let abort;
  try {
    const started = new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => {
        reject(new Error('Daemon readiness timed out: ' + stderr));
        abortBatch?.();
      }, 30_000);
      lines.on('line', line => {
        const value = ready(line);
        if (value) resolve(value);
      });
    });
    const value = await Promise.race([started, exited.then(({ code, signal }) => {
      throw spawnError ?? new Error(`Daemon exited before ready (${signal ?? code}): ${stderr}`);
    })]);
    return { ...state, value };
  } catch (error) {
    await stopDaemon(state);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function stopDaemon({ child, exited, monitor, observation }) {
  if (child.pid && !observation?.killed && child.exitCode === null && child.signalCode === null) {
    killProcessGroup(child.pid, 'SIGTERM');
    if (!await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })])) {
      if (monitor) monitor.terminate(observation);
      else killProcessGroup(child.pid);
    }
  }
  await exited;
}

async function runSetup(ctx, args, stdinText) {
  const result = await runMonitoredProcess({
    command: ctx.command, args, env: ctx.env, cwd: ctx.workspace, stdinText,
    timeoutMs: 30_000, monitor: ctx.monitor, onTimeout: ctx.abortBatch,
  });
  if (result.code !== 0 || result.termination || result.stdinError) {
    throw new Error(`Setup ${args.slice(0, 2).join(' ')} failed (${result.termination ?? result.signal ?? result.code}): ${result.stderr}`);
  }
}

function mcpDiscovery(body, path) {
  const callId = 'bench-discovery-' + path.split('/')[3];
  const tools = body.tools ?? [];
  const ready = tools.some(tool => tool.function?.name.startsWith('mcp__bench__'));
  const isDiscoveryCall = call => call.id === callId && call.function?.name === 'tool_search';
  const hasReceipt = body.messages.some(message => message.role === 'tool' && message.tool_call_id === callId);
  if (ready) {
    // This adapter-owned call never entered the canonical scenario or its receipt journal.
    body.messages = body.messages.filter(message =>
      !(message.role === 'tool' && message.tool_call_id === callId)
      && !(message.role === 'assistant' && message.tool_calls?.length === 1 && isDiscoveryCall(message.tool_calls[0])));
    return { forwarded: JSON.stringify(body) };
  }
  if (hasReceipt || !tools.some(tool => tool.function?.name === 'tool_search')) {
    throw new Error('Maka did not expose the benchmark MCP tools after discovery');
  }
  const call = {
    id: callId, type: 'function',
    function: { name: 'tool_search', arguments: JSON.stringify({ query: 'bench', limit: 20 }) },
  };
  const response = { id: 'resp_' + callId, model: body.model, created: 0 };
  return body.stream ? {
    contentType: 'text/event-stream',
    reply: [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' },
    ].map(choice => 'data: ' + JSON.stringify({
      ...response, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }],
    }) + '\n\n').join('') + 'data: [DONE]\n\n',
  } : {
    contentType: 'application/json',
    reply: JSON.stringify({ ...response, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', tool_calls: [call] }, finish_reason: 'tool_calls' }],
    }),
  };
}

export async function startProviderProxy(origin, { discoverMcp, retryAfterMs } = {}) {
  const upstreamUrl = new URL(origin);
  const server = createServer(async (incoming, outgoing) => {
    if (!incoming.url.startsWith('/s/')) {
      outgoing.writeHead(404).end();
      return;
    }
    const headers = { ...incoming.headers, host: upstreamUrl.host };
    let forwarded;
    if (discoverMcp && incoming.method === 'POST' && incoming.url.endsWith('/chat/completions')) {
      try {
        const result = mcpDiscovery(JSON.parse(await consumeText(incoming)), incoming.url);
        if (result.reply) {
          outgoing.writeHead(200, { 'content-type': result.contentType }).end(result.reply);
          return;
        }
        forwarded = result.forwarded;
        delete headers['transfer-encoding'];
        headers['content-length'] = Buffer.byteLength(forwarded);
      } catch (error) {
        outgoing.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: { message: error.message },
        }));
        return;
      }
    }
    const upstream = request(upstreamUrl, { path: incoming.url, method: incoming.method, headers }, reply => {
      const replyHeaders = { ...reply.headers };
      if (reply.statusCode === 429 && retryAfterMs !== undefined) {
        replyHeaders['retry-after-ms'] = String(retryAfterMs);
        replyHeaders['retry-after'] = String(Math.ceil(retryAfterMs / 1000));
      }
      outgoing.writeHead(reply.statusCode, replyHeaders);
      outgoing.flushHeaders();
      reply.on('error', error => outgoing.destroy(error));
      reply.pipe(outgoing);
    });
    outgoing.once('close', () => upstream.destroy());
    upstream.on('error', error => outgoing.destroy(error));
    incoming.on('error', error => upstream.destroy(error));
    if (forwarded !== undefined) upstream.end(forwarded);
    else incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    async stop() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

function makaAdapter(id, codeMode) {
  const tracks = codeMode ? native : both;
  return adapter({
    id, harness: 'maka', supportedTracks: tracks, shared: tracks,
    installHint: 'cargo build --release -p maka-cli',
    async start(ctx, lanes = [ctx]) {
      const root = join(ctx.isolatedDir, 'maka-root');
      const connections = lanes.map(lane => ({
        slug: lane.logicalLane, name: lane.logicalLane, provider: 'openai-compatible',
        configuration: { baseUrl: lane.v1 }, apiKey: lane.apiKey, enabledModelIds: [lane.model],
        modelOverrides: {
          [lane.model]: { codeMode, apiProtocol: chat, ...(codeMode ? { codeModeLanguage: 'javascript' } : {}) },
        },
      }));
      await runSetup(ctx, ['host', 'init', '--root', root, '--settings-stdin'], JSON.stringify({
        connections,
        defaultTarget: { slug: connections[0].slug, modelId: lanes[0].model },
        chatDefaults: { sandboxMode: 'danger-full-access' },
        projectDirectoryRoots: lanes.map(lane => ({ label: lane.logicalLane, path: lane.workspace })),
      }));
      const host = await startChild(ctx.command, ['host', 'serve', '--root', root], ctx,
        line => line.startsWith('{"kind":"ready",') && root);
      return { ...host, tempDir: ctx.env.TMPDIR };
    },
    prepare(ctx) {
      const host = ctx.daemonState;
      if (!host) throw new Error(`${id} requires a shared Host`);
      return {
        command: process.execPath, args: [script, '--maka-acp'],
        env: { ...ctx.env, TMPDIR: host.tempDir },
        stdinText: JSON.stringify({
          command: ctx.command, root: host.value, lane: ctx.logicalLane, prompt: ctx.prompt, mcp: ctx.mcp,
        }),
      };
    },
  });
}

async function runMakaAcp() {
  const { command, root, lane, prompt, mcp } = JSON.parse(await consumeText(process.stdin));
  const child = spawn(command, ['acp', '--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  let failure;
  child.once('error', error => { failure = error; });
  child.stdin.on('error', error => { failure ??= error; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = lines[Symbol.asyncIterator]();
  let id = 0;
  let answer = '';
  async function rpc(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    for (;;) {
      const { done, value } = await messages.next();
      if (done) throw failure ?? new Error('Maka ACP closed while awaiting ' + method);
      const message = JSON.parse(value);
      if (message.id === id && !message.method) {
        if (message.error) throw new Error(method + ': ' + JSON.stringify(message.error));
        return message.result;
      }
      if (message.method === 'session/update') {
        const { update } = message.params;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          answer += update.content.text;
        }
      } else if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported benchmark ACP client method' },
        }) + '\n');
      }
    }
  }
  try {
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId, configOptions } = await rpc('session/new', {
      cwd: process.cwd(), mcpServers: mcp ? [{ name: 'bench', ...mcp, env: [] }] : [],
    });
    const selected = configOptions.find(option => option.id === 'model')?.options
      .find(option => option.name.endsWith(' (' + lane + ')'));
    if (!selected) throw new Error('Maka ACP did not advertise the provider for ' + lane);
    await rpc('session/set_config_option', { sessionId, configId: 'model', type: 'id', value: selected.value });
    const result = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    if (result.stopReason !== 'end_turn' || !answer.trim()) {
      throw new Error('Maka ACP prompt did not return an answer: ' + JSON.stringify(result));
    }
    process.stdout.write(answer + '\n');
  } finally {
    child.stdin.end();
    lines.close();
    child.stdout.resume();
    const { code, signal } = await closed;
    if (failure) throw failure;
    if (code !== 0) throw new Error('Maka ACP exited: ' + (signal ?? code));
  }
}

const claude = adapter({
  id: 'claude', protocol: anthropic, supportedTracks: both,
  installHint: 'Install Claude Code (claude on PATH).',
  async prepare(ctx) {
    const home = join(ctx.isolatedDir, 'claude');
    await mkdir(home, { recursive: true, mode: 0o700 });
    Object.assign(ctx.env, {
      CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: ctx.base, ANTHROPIC_AUTH_TOKEN: ctx.apiKey,
      DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const args = ['-p', ctx.prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--model', ctx.model];
    if (ctx.mcp) {
      const path = join(home, 'mcp-config.json');
      await jsonFile(path, { mcpServers: { bench: { type: 'stdio', ...ctx.mcp } } });
      args.push('--mcp-config', path, '--strict-mcp-config');
    }
    return { args };
  },
});

function codexAdapter(ws) {
  return adapter({
    id: ws ? 'codex-ws' : 'codex-http', harness: 'codex', protocol: ws ? websockets : responses,
    supportedTracks: both,
    defaultModel: 'gpt-5.5',
    installHint: 'npm install -g @openai/codex. Use a model with apply_patch.',
    async prepare(ctx) {
      ctx.env.CODEX_HOME = join(ctx.isolatedDir, 'codex');
      ctx.env.OPENAI_API_KEY = ctx.apiKey;
      const lines = [
        `model = ${toml(ctx.model)}`, 'model_provider = "mock"', 'check_for_update_on_startup = false',
        '[model_providers.mock]', 'name = "Benchmark mock"', 'wire_api = "responses"',
        `base_url = ${toml(ctx.v1)}`, 'env_key = "OPENAI_API_KEY"', 'requires_openai_auth = false',
        `supports_websockets = ${ws}`, 'request_max_retries = 4', 'stream_max_retries = 4',
        '[features]', 'plugins = false',
      ];
      if (ctx.mcp) lines.push(
        '[mcp_servers.bench]', `command = ${toml(ctx.mcp.command)}`,
        `args = ${toml(ctx.mcp.args)}`, 'required = true',
        // The scenario binds the tool schemas Codex sends in the Responses request.
        'omit_tools_from = ["deferred"]',
      );
      await privateFile(join(ctx.env.CODEX_HOME, 'config.toml'), lines.join('\n') + '\n');
      return { args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '-'],
        stdinText: ctx.prompt };
    },
  });
}

async function configureOpencode(ctx, lanes) {
  const config = join(ctx.isolatedDir, 'opencode.json');
  Object.assign(ctx.env, {
    OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  });
  const providers = lanes ?? [{ ...ctx, logicalLane: 'mock' }];
  await jsonFile(config, {
    model: `${providers[0].logicalLane}/${providers[0].model}`,
    providers: Object.fromEntries(providers.map(lane => [lane.logicalLane, {
      name: 'Benchmark ' + lane.logicalLane, package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: lane.v1, apiKey: lane.apiKey },
      models: { [lane.model]: { name: lane.model } },
    }])),
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    ...(!lanes && ctx.mcp ? { mcp: { servers: { bench: {
      type: 'local', codemode: false, command: [ctx.mcp.command, ...ctx.mcp.args],
    } } } } : {}),
  });
}

function opencodeAdapter(id, tracks) {
  const attach = id !== 'opencode-cold';
  return adapter({
    id, harness: 'opencode', supportedTracks: tracks,
    installHint: 'Install OpenCode v2 (opencode on PATH).',
    ...(attach ? {
      shared: native,
      async start(ctx, lanes) {
        await configureOpencode(ctx, lanes);
        const password = randomBytes(24).toString('hex');
        ctx.env.OPENCODE_PASSWORD = password;
        const state = await startChild(ctx.command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], ctx,
          line => /https?:\/\/127\.0\.0\.1:[1-9][0-9]*/.exec(line)?.[0]);
        return { ...state, shared: Boolean(lanes), password };
      },
    } : {}),
    async prepare(ctx) {
      let server = ['--standalone'];
      let provider = 'mock';
      if (attach) {
        if (!ctx.daemonState) throw new Error(id + ' requires its daemon');
        ctx.env.OPENCODE_PASSWORD = ctx.daemonState.password;
        server = ['--server', ctx.daemonState.value];
        if (ctx.daemonState.shared) provider = ctx.logicalLane;
      } else {
        await configureOpencode(ctx);
      }
      return { args: ['run', ...server, '--model', `${provider}/${ctx.model}`, '--format', 'json', '--', ctx.prompt] };
    },
  });
}

const pi = adapter({
  id: 'pi', installHint: 'Install pi (pi on PATH).',
  async prepare(ctx) {
    ctx.env.PI_CODING_AGENT_DIR = join(ctx.isolatedDir, 'pi');
    ctx.env.OPENAI_API_KEY = ctx.apiKey;
    const home = ctx.env.PI_CODING_AGENT_DIR;
    await Promise.all([
      jsonFile(join(home, 'models.json'), { providers: { mock: {
        baseUrl: ctx.v1, api: 'openai-completions', apiKey: '$OPENAI_API_KEY',
        models: [{ id: ctx.model, name: ctx.model }],
      } } }),
      jsonFile(join(home, 'settings.json'), { defaultProvider: 'mock', defaultModel: ctx.model }),
    ]);
    return { args: ['-p', '--mode', 'json', '--no-session', '--', ctx.prompt] };
  },
});

const durablePackages = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'];
const durableImports = {
  Harness: '@earendil-works/pi-durable',
  sqlite: '@earendil-works/pi-durable/storage/sqlite/node',
  tools: '@earendil-works/pi-durable/tools',
  environment: '@earendil-works/pi-durable/env/node',
  ai: '@earendil-works/pi-ai',
  completions: '@earendil-works/pi-ai/api/openai-completions.lazy',
  context: '@earendil-works/chord/context',
};

async function durableEntries(env, repoRoot, invocation) {
  const directory = resolve(env.HARNESS_BENCH_PI_DURABLE_DIR ?? repoRoot);
  const imports = JSON.stringify(durableImports);
  const expression = `console.log(JSON.stringify(Object.fromEntries(
    Object.entries(${imports}).map(([name, specifier]) => [name, import.meta.resolve(specifier)]))))`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', expression], {
    ...invocation, cwd: directory,
  });
  return JSON.parse(stdout);
}

async function prepareDurable(ctx, batchLanes) {
  const lanes = batchLanes ?? [ctx];
  const entries = await durableEntries(ctx.source, ctx.repoRoot, { env: ctx.env, timeout: 8_000 });
  const path = join(ctx.isolatedDir, 'pi-durable-driver.mjs');
  const configs = lanes.map(({ model, sessionId, workspace, logicalLane, v1, runId, scopedOrigin, apiKey }, index) => {
    const keyEnv = 'HARNESS_BENCH_PI_KEY_' + index;
    ctx.env[keyEnv] = apiKey;
    return { model: model ?? ctx.model, sessionId, workspace, logicalLane, keyEnv,
      baseUrl: v1 ?? scopedUrl(scopedOrigin, runId, sessionId) + '/v1' };
  });
  await privateFile(path, `import { readFileSync } from 'node:fs';
import { Harness, AssistantEntry, createRegistry } from ${toml(entries.Harness)};
import { openNodeSqliteStorage } from ${toml(entries.sqlite)};
import { createCodingTools } from ${toml(entries.tools)};
import { NodeExecutionEnv } from ${toml(entries.environment)};
import { createModels, createProvider, envApiKeyAuth } from ${toml(entries.ai)};
import { openAICompletionsApi } from ${toml(entries.completions)};
import { BACKGROUND_CONTEXT as context } from ${toml(entries.context)};

const lanes = ${toml(configs)};
const emit = ${Boolean(batchLanes)}
  ? row => console.log(JSON.stringify(row))
  : row => {
    if (row.error) throw new Error(row.error);
    console.log(row.answer);
  };
const models = createModels();
for (const { logicalLane: id, model, baseUrl, keyEnv } of lanes) {
  models.setProvider(createProvider({
    id, name: id, baseUrl,
    auth: { apiKey: envApiKeyAuth(id, [keyEnv]) },
    api: openAICompletionsApi(),
    models: [{
      id: model, name: model, api: 'openai-completions', provider: id, baseUrl,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1047576, maxTokens: 32768,
    }],
  }));
}
const registry = createRegistry();
registry.install(createCodingTools());
const storage = await openNodeSqliteStorage(${toml(join(ctx.isolatedDir, 'pi-durable.sqlite'))});
const harness = await Harness.open(storage, { models, registry,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd }),
}, context);
try {
  const prompt = readFileSync(0, 'utf8');
  harness.resume();
  await Promise.all(lanes.map(async ({ logicalLane, model, sessionId, workspace }) => {
    const startNs = process.hrtime.bigint();
    let result;
    try {
      const options = { agent: { model: { provider: logicalLane, modelId: model }, cwd: workspace } };
      const root = await harness.createConversation({ ...options, ownership: { kind: 'ownerless' } }, context);
      const submission = await root.submit({ type: 'input', content: prompt, requestId: sessionId }, context);
      const settled = await submission.wait(context);
      if (settled.status !== 'done' || settled.type !== 'input') {
        throw new Error('pi-durable did not produce an answer: ' + JSON.stringify(settled));
      }
      const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
      const text = answer?.model?.flatMap(message => message.content ?? [])
        .filter(block => block.type === 'text').map(block => block.text).join('');
      if (!text) throw new Error('pi-durable returned an empty answer');
      result = { answer: text };
    } catch (error) {
      result = { error: error.message };
    }
    emit({ logicalLane, ...result, wallMs: Number(process.hrtime.bigint() - startNs) / 1e6 });
  }));
} finally {
  await harness.close(context);
}
`);
  return { args: [path], stdinText: ctx.prompt };
}

function piDurableAdapter(shared) {
  return adapter({
    id: shared ? 'pi-durable-shared' : 'pi-durable', locate: () => process.execPath,
    installHint: `Install ${durablePackages.join(' ')} in a directory and set HARNESS_BENCH_PI_DURABLE_DIR to it.`,
    async version(env, repoRoot, invocation) {
      const entries = await durableEntries(env, repoRoot, invocation);
      const path = join(dirname(fileURLToPath(entries.Harness)), '../package.json');
      return JSON.parse(await readFile(path, 'utf8')).version;
    },
    ...(shared ? { batch: prepareDurable } : { prepare: prepareDurable }),
  });
}

const dim = adapter({
  id: 'dim', binary: 'dimcode', supportedTracks: both, versionArgs: ['version'],
  installHint: 'npm install -g dimcode',
  async prepare(ctx) {
    const path = join(ctx.isolatedDir, 'model.json');
    await jsonFile(path, { adapter: 'openai', baseUrl: ctx.v1, model: ctx.model });
    // Released Dim resolves custom providers from its SQLite catalog.
    await runSetup(ctx, ['provider', 'add', 'bench-mock', '--adapter', 'openai',
      '--base-url', ctx.v1, '--api-key', ctx.apiKey, '--model', ctx.model]);
    await runSetup(ctx, ['provider', 'switch', 'bench-mock', '--model', ctx.model]);
    if (ctx.mcp) await runSetup(ctx, ['mcp', 'add-json', 'bench', JSON.stringify(ctx.mcp)]);
    return { args: ['exec', '--model-config', path], stdinText: ctx.prompt };
  },
});

const dsh = adapter({
  id: 'dsh', supportedTracks: both, installHint: 'npm install -g @deepseek-ai/dsh',
  async prepare(ctx) {
    ctx.env.DSH_HOME = join(ctx.isolatedDir, 'dsh');
    ctx.env.OPENAI_API_KEY = ctx.apiKey;
    // JSON is a YAML subset and preserves paths and prompts without custom quoting.
    const patches = [{
      id: 'llm-pi-ai', config: { providers: { mock: {
        api: 'openai-completions', baseURL: ctx.v1, apiKeyEnv: 'OPENAI_API_KEY',
        models: [{ id: ctx.model }],
      } } },
    }, {
      id: 'agent-default-model', config: { provider: 'mock', model: ctx.model },
    }];
    if (ctx.mcp) patches.push({ insert: [{
      id: 'bench-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'stdio', serverName: 'bench', ...ctx.mcp, cwd: ctx.workspace, failOnStartupError: true,
      },
    }] });
    await jsonFile(join(ctx.env.DSH_HOME, 'cordis.patch.yml'), patches);
    return { args: ['--profile', 'headless', '--', ctx.prompt] };
  },
});

const zcode = adapter({
  id: 'zcode', supportedTracks: both, installHint: 'Install the ZCode CLI (zcode on PATH).',
  async prepare(ctx) {
    const home = join(ctx.env.HOME, '.zcode', 'v2');
    const secret = join(home, 'credential-secret');
    await privateFile(secret, randomBytes(32).toString('hex'), { exclusive: true });
    Object.assign(ctx.env, {
      ZCODE_DATA_BASE_DIR: ctx.env.HOME, ZCODE_CREDENTIAL_SECRET_FILE: secret, OPENAI_API_KEY: ctx.apiKey,
    });
    await jsonFile(join(home, 'config.json'), {
      model: {
        main: { kind: 'openai-compatible', provider: 'mock', model: ctx.model, baseURL: ctx.v1, apiKey: ctx.apiKey },
      },
    });
    const selection = { providerId: 'mock', modelId: ctx.model };
    await jsonFile(join(home, 'provider_config.json'), {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{
          providerId: 'mock', providerName: 'Benchmark mock', enabled: true,
          config: {
            group: 'standard-personal', api: { type: chat, baseUrl: ctx.v1 },
            access: { type: 'api-key', apiKey: ctx.apiKey }, personalModelIds: [ctx.model],
          },
        }] },
        modelConfigRules: {
          providerModelRules: [{ ...selection, config: { enabled: true, properties: { contextWindow: 1047576 } } }],
          manualProviderModelRules: [],
        },
        defaultModelSelection: selection,
      },
    });
    if (ctx.mcp) await jsonFile(join(ctx.env.HOME, '.zcode/cli/config.json'), {
      mcp: { servers: { bench: { type: 'stdio', ...ctx.mcp, cwd: ctx.workspace } } },
    });
    return { args: ['-p', ctx.prompt] };
  },
});

function kimiAdapter(id, protocol, type) {
  return adapter({
    id, harness: 'kimi', protocol, supportedTracks: both,
    installHint: 'npm install -g @moonshot-ai/kimi-code',
    async prepare(ctx) {
      const home = join(ctx.isolatedDir, 'kimi');
      ctx.env.KIMI_CODE_HOME = home;
      const path = join(home, 'config.toml');
      await privateFile(path, [
        'default_model = "mock"', 'telemetry = false', '[providers.mock]', `type = ${toml(type)}`,
        `base_url = ${toml(type === 'anthropic' ? ctx.base : ctx.v1)}`,
        `api_key = ${toml(ctx.apiKey)}`, '[models.mock]', 'provider = "mock"',
        `model = ${toml(ctx.model)}`, 'max_context_size = 1047576', '',
      ].join('\n'));
      if (ctx.mcp) await jsonFile(join(home, 'mcp.json'), {
        mcpServers: { bench: { transport: 'stdio', ...ctx.mcp, deferred: false } },
      });
      return { args: ['-p', ctx.prompt] };
    },
  });
}

const refAgent = adapter({
  id: 'ref-agent', supportedTracks: both, locate: () => process.execPath,
  installHint: 'Built in. Uses Node.js 26.',
  prepare(ctx) {
    const protocol = ctx.protocol ?? chat;
    if (![chat, anthropic].includes(protocol)) throw new Error(`ref-agent does not support ${protocol}`);
    ctx.env.HARNESS_BENCH_REF_KEY = ctx.apiKey;
    return {
      args: [script, '--ref-agent'],
      stdinText: JSON.stringify({
        endpoint: ctx.v1 + (protocol === anthropic ? '/messages' : '/chat/completions'),
        protocol, model: ctx.model, prompt: ctx.prompt, mcp: ctx.mcp, stream: ctx.stream,
        checkpoint: ctx.resumeAfterKill ? join(ctx.isolatedDir, 'ref-checkpoint.json') : undefined,
      }),
    };
  },
});

const adapters = [
  refAgent, makaAdapter('maka-direct', false), makaAdapter('maka-codemode', true), claude,
  codexAdapter(true), codexAdapter(false), opencodeAdapter('opencode-cold', both), opencodeAdapter('opencode-attach', both),
  pi, piDurableAdapter(false), dim, dsh, zcode,
  kimiAdapter('kimi-openai', chat, 'openai'),
  kimiAdapter('kimi-responses', responses, 'openai_responses'),
  kimiAdapter('kimi-anthropic', anthropic, 'anthropic'),
  makaAdapter('maka-host-direct', false), makaAdapter('maka-host-codemode', true),
  opencodeAdapter('opencode-serve', native), piDurableAdapter(true),
];

export function getAdapter(id) {
  const adapter = adapters.find(adapter => adapter.id === id);
  if (!adapter) throw new Error(`Unknown benchmark adapter ${JSON.stringify(id)}`);
  return adapter;
}

export function listAdapters() {
  return [...adapters];
}

export async function probeAllAdapters({ env, repoRoot, filter } = {}) {
  let selected = adapters;
  if (typeof filter === 'function') {
    selected = adapters.filter(filter);
  } else if (filter !== undefined) {
    const ids = typeof filter === 'string' ? filter.split(',') : [...filter];
    selected = ids.map(getAdapter);
  }
  return Promise.all(selected.map(adapter => adapter.probe({ env, repoRoot })));
}

const referenceTools = [
  ['Read', 'Read a workspace file.', ['path']],
  ['Write', 'Write a workspace file.', ['path', 'content']],
  ['Edit', 'Replace exactly one match in a workspace file.', ['path', 'old_string', 'new_string']],
  ['Bash', 'Run a fixture grep or printf command.', ['command']],
].map(([name, description, required]) => ({
  name, description,
  inputSchema: {
    type: 'object', required, additionalProperties: false,
    properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])),
  },
}));

async function referenceNative(workspace, name, args) {
  if (name === 'Bash') {
    // scenario::large_output_command quotes fixture data and inserts three decimal loop bounds.
    const large = /^BENCH_PATTERN='((?:[^']|'\\'')*)' BENCH_TAIL='((?:[^']|'\\'')*)' LC_ALL=C awk 'BEGIN \{ p = ENVIRON\["BENCH_PATTERN"\]; for \(i = 0; i < (\d+); i\+\+\) block = block p; for \(i = 0; i < (\d+); i\+\+\) printf "%s", block; for \(i = 0; i < (\d+); i\+\+\) printf "%s", p; printf "%s", ENVIRON\["BENCH_TAIL"\] \}'$/.exec(args.command);
    if (large?.[0] === args.command) {
      const [, pattern, tail, perBlock, blocks, repetitions] = large;
      const { stdout } = await exec('/usr/bin/awk', [
        '-v', 'perBlock=' + perBlock, '-v', 'blocks=' + blocks, '-v', 'repetitions=' + repetitions,
        'BEGIN { p = ENVIRON["BENCH_PATTERN"]; for (i = 0; i < perBlock; i++) block = block p; for (i = 0; i < blocks; i++) printf "%s", block; for (i = 0; i < repetitions; i++) printf "%s", p; printf "%s", ENVIRON["BENCH_TAIL"] }',
      ], {
        cwd: workspace, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
        env: {
          LC_ALL: 'C', BENCH_PATTERN: pattern.replaceAll("'\\''", "'"), BENCH_TAIL: tail.replaceAll("'\\''", "'"),
        },
      });
      return { text: stdout };
    }
    const sleep = /^sleep 0\.1 && printf '(burst-probe-[0-9]+-[0-9]+)'$/.exec(args.command);
    if (sleep) {
      const { stdout } = await exec('/bin/sh', ['-c', 'sleep 0.1 && printf "%s" "$1"', 'bench', sleep[1]], {
        cwd: workspace, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10_000,
      });
      return { text: stdout };
    }
    const parsed = parseBenchmarkCommand(args.command);
    const argv = parsed.kind === 'grep'
      ? ['exec grep -Fx -- "$1" "$2"', parsed.marker, await resolveWorkspaceFile(workspace, parsed.path)]
      : ['printf "%s" "$1"', parsed.text];
    const [source, ...operands] = argv;
    const { stdout, stderr } = await exec('/bin/sh', ['-c', source, 'bench', ...operands], {
      cwd: workspace, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10_000,
    });
    return { text: stdout + stderr };
  }
  const path = await resolveWorkspaceFile(workspace, args.path, { create: name === 'Write' });
  if (name === 'Write') {
    await writeFile(path, args.content, {
      flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    });
  } else {
    const content = await readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    if (name === 'Read') return { text: content };
    await writeFile(path, replaceUnique(content, args.old_string, args.new_string), {
      flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
    });
  }
  return { text: 'OK' };
}

async function connectReferenceMcp(mcp, workspace) {
  const child = spawn(mcp.command, mcp.args, {
    cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 0;
  let failure;
  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    child.kill();
  }
  child.once('error', fail);
  child.stdin.on('error', fail);
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => {
      if (code !== 0 || pending.size) fail(new Error(`MCP server closed (${signal ?? code})`));
      resolveClose({ code, signal });
    });
  });
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (!request) throw new Error(`Unexpected MCP response ID ${response.id}`);
      pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error.message));
      else request.resolve(response.result);
    } catch (error) {
      fail(error);
    }
  });
  function request(method, params) {
    if (failure) throw failure;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05', clientInfo: { name: 'ref-agent', version: '1.0.0' },
      capabilities: {},
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await request('tools/list');
    return {
      tools,
      async call(name, args) {
        const reply = await request('tools/call', { name, arguments: args });
        return { text: reply.content.map(block => block.text).join('\n'), isError: reply.isError };
      },
      async close() {
        child.stdin.end();
        const result = await closed;
        if (failure) throw failure;
        if (result.code !== 0) throw new Error(`MCP server failed to close: ${result.signal ?? result.code}`);
      },
    };
  } catch (error) {
    fail(error);
    await closed;
    throw error;
  }
}

class RefRequestError extends Error {
  constructor(message, { status, provider, retryAfter, retryAfterMs, cause, disconnected } = {}) {
    super(message, { cause });
    this.status = status;
    this.provider = provider;
    this.retryAfter = retryAfter;
    this.retryAfterMs = retryAfterMs;
    this.disconnected = disconnected;
  }

  get overflow() {
    return this.provider?.code === 'context_length_exceeded'
      || (this.provider?.type === 'invalid_request_error' && /prompt is too long/i.test(this.provider.message));
  }

  get retryable() {
    return this.disconnected || this.status === 429 || this.status === 503
      || ['rate_limit_error', 'overloaded_error'].includes(this.provider?.type);
  }
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let data = [];
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new RefRequestError('Model stream disconnected', { disconnected: true, cause });
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (!line && data.length) {
          const event = data.join('\n');
          data = [];
          yield event;
        }
      }
    }
  } finally {
    if (reader.closed) await reader.cancel().catch(error => {
      if (!(error instanceof TypeError)) throw error;
    });
    reader.releaseLock();
  }
}

function responseError(error) {
  return new RefRequestError(error?.message ?? 'Model returned a stream error', { provider: error });
}

async function decodeRefStream(response, isAnthropic) {
  const blocks = new Map();
  const calls = new Map();
  let content = '';
  let complete = false;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') {
      if (isAnthropic) throw new Error('Unexpected OpenAI stream terminator');
      complete = true;
      break;
    }
    const event = JSON.parse(data);
    if (event.error || event.type === 'error') throw responseError(event.error);
    if (isAnthropic) {
      if (event.type === 'message_stop') {
        complete = true;
        break;
      }
      if (event.type === 'content_block_start') {
        blocks.set(event.index, { ...event.content_block });
      }
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (delta.type === 'text_delta') block.text += delta.text;
        if (delta.type === 'input_json_delta') block.partial = (block.partial ?? '') + delta.partial_json;
        if (delta.type === 'compaction_delta') block.content = (block.content ?? '') + delta.content;
      }
    } else {
      const delta = event.choices?.[0]?.delta;
      content += delta?.content ?? '';
      for (const piece of delta?.tool_calls ?? []) {
        if (!calls.has(piece.index)) calls.set(piece.index, {
          type: 'function', id: '', function: { name: '', arguments: '' },
        });
        const call = calls.get(piece.index);
        call.id += piece.id ?? '';
        call.function.name += piece.function?.name ?? '';
        call.function.arguments += piece.function?.arguments ?? '';
      }
    }
  }
  if (!complete) throw new RefRequestError('Model stream ended before its terminal event', { disconnected: true });
  if (!isAnthropic) {
    return { role: 'assistant', content, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
  }
  return { role: 'assistant', content: [...blocks.values()].map(({ partial, ...block }) => {
    if (partial === undefined) return block;
    try {
      return { ...block, input: JSON.parse(partial) };
    } catch {
      return { ...block, input: partial };
    }
  }) };
}

async function refRequest(config, messages, tools, summary = false) {
  const isAnthropic = config.protocol === anthropic;
  const headers = {
    'content-type': 'application/json',
    ...(isAnthropic
      ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' }
      : { authorization: 'Bearer ' + config.key }),
    ...(summary ? { 'x-maka-bench-request-use': 'client_summary' } : {}),
  };
  const body = JSON.stringify({
    model: config.model, stream: config.stream !== false, messages,
    ...(isAnthropic ? { max_tokens: 8192 } : {}),
    ...(tools.length ? { tools: tools.map(({ name, description, inputSchema }) => isAnthropic
      ? { name, description, input_schema: inputSchema }
      : { type: 'function', function: { name, description, parameters: inputSchema } }) } : {}),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      let response;
      try {
        response = await fetch(config.endpoint, {
          method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(120_000),
        });
      } catch (cause) {
        throw new RefRequestError('Model connection failed', { disconnected: true, cause });
      }
      if (!response.ok) {
        const raw = await response.text();
        let provider;
        if (response.headers.get('content-type')?.includes('json')) provider = JSON.parse(raw).error;
        throw new RefRequestError(provider?.message ?? raw, {
          status: response.status, provider, retryAfter: response.headers.get('retry-after'),
          retryAfterMs: response.headers.get('retry-after-ms'),
        });
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        return await decodeRefStream(response, isAnthropic);
      }
      const data = await response.json();
      if (data.error) throw responseError(data.error);
      if (isAnthropic) return { role: 'assistant', content: data.content };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error('Model JSON response has no assistant message');
      return message;
    } catch (error) {
      if (!error.retryable || attempt >= 4) throw error;
      const seconds = Number(error.retryAfter);
      const retryAfter = error.retryAfterMs !== null && error.retryAfterMs !== undefined
        ? Number(error.retryAfterMs)
        : !error.retryAfter ? 0 : Number.isFinite(seconds)
          ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now();
      await delay(Math.max(50 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0));
    }
  }
}

const assistantText = message => typeof message.content === 'string'
  ? message.content
  : message.content.filter(block => block.type === 'text').map(block => block.text).join('');

async function compactReference(config, history) {
  const instruction = 'Summarize the task, changes, and important facts. Preserve checkpoint IDs and proof markers exactly.';
  const excerpt = history.map(message => {
    const text = JSON.stringify(message);
    return text.length > 2048 ? text.slice(0, 1024) + ' … ' + text.slice(-1024) : text;
  }).join('\n').slice(-32_768);
  const summary = assistantText(await refRequest(config, [{
    role: 'user', content: instruction + '\n\n' + excerpt,
  }], [], true));
  if (!summary.trim()) throw new Error('Model returned an empty compaction summary');
  return [{ role: 'user', content: 'Continue from this conversation summary:\n' + summary }];
}

async function executeReferenceCall(toolset, call, invoke) {
  try {
    const schema = toolset.find(tool => tool.name === call.name)?.inputSchema;
    if (!schema) throw new Error(`Unknown tool ${call.name}`);
    const args = call.json ? JSON.parse(call.args) : call.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).length !== schema.required.length
        || schema.required.some(key => !Object.hasOwn(args, key) || typeof args[key] !== 'string')) {
      throw new Error(`Invalid arguments for ${call.name}`);
    }
    return await invoke(call.name, args);
  } catch (error) {
    return { text: error.message, isError: true };
  }
}

export async function runRefAgentCli() {
  const config = JSON.parse(await consumeText(process.stdin));
  config.key = process.env.HARNESS_BENCH_REF_KEY;
  let history = [{ role: 'user', content: config.prompt }];
  let compactedAtTurn = false;
  if (config.checkpoint) {
    try {
      ({ history, compactedAtTurn } = JSON.parse(await readFile(config.checkpoint, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function saveCheckpoint() {
    const next = config.checkpoint + '.next';
    await jsonFile(next, { history, compactedAtTurn });
    await rename(next, config.checkpoint);
  }
  const workspace = await realpath(process.cwd());
  const shared = config.mcp ? await connectReferenceMcp(config.mcp, workspace) : undefined;
  const tools = shared?.tools ?? referenceTools;
  const invoke = shared?.call ?? ((name, args) => referenceNative(workspace, name, args));
  const isAnthropic = config.protocol === anthropic;
  try {
    for (let round = 0; round < 1024; round++) {
      let message;
      try {
        message = await refRequest(config, history, tools);
      } catch (error) {
        if (!error.overflow || compactedAtTurn) throw error;
        history = await compactReference(config, history);
        compactedAtTurn = true;
        if (config.checkpoint) await saveCheckpoint();
        continue;
      }
      const calls = isAnthropic
        ? message.content.filter(block => block.type === 'tool_use').map(block => ({
          id: block.id, name: block.name, args: block.input,
        }))
        : (message.tool_calls ?? []).map(call => ({
          id: call.id, name: call.function.name, args: call.function.arguments, json: true,
        }));
      if (calls.length) {
        const outcomes = await Promise.all(calls.map(call => executeReferenceCall(tools, call, invoke)));
        history.push(message);
        if (isAnthropic) {
          history.push({ role: 'user', content: outcomes.map(({ text, isError }, index) => ({
            type: 'tool_result', tool_use_id: calls[index].id, content: text, is_error: Boolean(isError),
          })) });
        } else {
          history.push(...outcomes.map(({ text, isError }, index) => ({
            role: 'tool', tool_call_id: calls[index].id, content: text, is_error: Boolean(isError),
          })));
        }
        compactedAtTurn = false;
        if (config.checkpoint) await saveCheckpoint();
        continue;
      }
      const text = assistantText(message);
      if (/^Compact the conversation and preserve cmp_\S+ \S+\.$/.test(text)) {
        if (compactedAtTurn) throw new Error('Repeated compaction checkpoint');
        history = await compactReference(config, [...history, message]);
        compactedAtTurn = true;
        if (config.checkpoint) await saveCheckpoint();
        continue;
      }
      if (!text.trim()) throw new Error('Model returned an empty final answer');
      process.stdout.write(text + '\n');
      return;
    }
    throw new Error('Reference agent exceeded its 1024-turn budget');
  } finally {
    await shared?.close();
  }
}

if (['--ref-agent', '--maka-acp'].includes(process.argv[2]) && process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    await (process.argv[2] === '--maka-acp' ? runMakaAcp() : runRefAgentCli());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
