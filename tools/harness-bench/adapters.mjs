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

async function isolatedEnv(directory, source) {
  const dirs = Object.fromEntries([
    ['HOME', 'home'], ['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'],
    ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state'], ['XDG_RUNTIME_DIR', 'runtime'],
    ['TMPDIR', 'tmp'], ['APPDATA', 'app-data'], ['LOCALAPPDATA', 'local-app-data'],
  ].map(([name, leaf]) => [name, join(directory, leaf)]));
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
  defaultModel = 'gpt-4.1', installHint, versionArgs = ['--version'], prepare, start, locate, version }) {
  const commandPath = locate ?? ((env, repoRoot) => findBinary(binary, env, repoRoot));
  const launchMode = start ? 'warm-daemon' : 'cold';
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
    const env = await isolatedEnv(isolatedDir, source);
    const mcp = track === 'sharedMcp' ? mcpServer({ ...options, workspace }) : undefined;
    return { ...options, model, base, v1: base + '/v1', isolatedDir, workspace, repoRoot, source, command, env, mcp };
  }
  return Object.freeze({
    id, harness, protocol, launchMode, supportedTracks, defaultModel,
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
    async prepareInvocation(options) {
      const ctx = await context(options);
      return { command: ctx.command, cwd: ctx.workspace, env: ctx.env, ...await prepare(ctx) };
    },
    ...(start ? {
      async startDaemon(options) {
        return start(await context(options));
      },
      stopDaemon,
    } : {}),
  });
}

function startChild(command, args, { env, workspace }, ready) {
  const child = spawn(command, args, {
    env, cwd: workspace, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const state = { child, exited: new Promise(resolveExit => {
    child.once('error', error => resolveExit({ error }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  }) };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timeout = AbortSignal.timeout(30_000);
  const started = new Promise((resolveReady, reject) => {
    timeout.addEventListener('abort', () => reject(new Error('Daemon readiness timed out')), { once: true });
    lines.on('line', line => {
      const value = ready(line);
      if (value) resolveReady(value);
    });
  });
  return Promise.race([started, state.exited.then(({ error, code, signal }) => {
    throw error ?? new Error(`Daemon exited before ready (${signal ?? code}): ${stderr}`);
  })]).then(value => ({ ...state, value }), async error => {
    await stopDaemon(state);
    throw error;
  });
}

async function stopDaemon({ child, exited }) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const target = process.platform === 'win32' ? child.pid : -child.pid;
    const sending = signal => {
      try {
        process.kill(target, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    sending('SIGTERM');
    if (!await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })])) {
      sending('SIGKILL');
    }
  }
  await exited;
}

async function runSetup(ctx, args, stdinText) {
  if (stdinText === undefined) {
    await exec(ctx.command, args, { env: ctx.env, cwd: ctx.workspace, timeout: 30_000 });
    return;
  }
  await new Promise((resolveRun, reject) => {
    const child = execFile(ctx.command, args, {
      env: ctx.env, cwd: ctx.workspace, timeout: 30_000,
    }, error => error ? reject(error) : resolveRun());
    child.stdin.on('error', reject);
    child.stdin.end(stdinText);
  });
}

function makaAdapter(id, codeMode) {
  const rootPath = ctx => join(ctx.isolatedDir, 'maka-root');
  return adapter({
    id, harness: 'maka', supportedTracks: codeMode ? native : both,
    installHint: 'cargo build --release -p maka-cli',
    async start(ctx) {
      const root = rootPath(ctx);
      if (ctx.mcp) await jsonFile(join(ctx.env.HOME, '.maka/mcp.json'), {
        mcpServers: { bench: { ...ctx.mcp, cwd: ctx.workspace } },
      });
      await runSetup(ctx, ['host', 'init', '--root', root, '--settings-stdin'], JSON.stringify({
        connections: [{
          slug: 'benchmark', provider: 'openai-compatible',
          configuration: { baseUrl: ctx.v1 }, apiKey: ctx.apiKey, enabledModelIds: [ctx.model],
          modelOverrides: {
            [ctx.model]: { codeMode, apiProtocol: chat, ...(codeMode ? { codeModeLanguage: 'javascript' } : {}) },
          },
        }],
        defaultTarget: { slug: 'benchmark', modelId: ctx.model },
        projectDirectoryRoots: [{ label: 'Benchmark workspace', path: ctx.workspace }],
      }));
      return startChild(ctx.command, ['host', 'serve', '--root', root], ctx,
        line => line.startsWith('{"kind":"ready",') && root);
    },
    prepare(ctx) {
      const root = rootPath(ctx);
      if (ctx.daemonState?.value !== root) throw new Error(`${id} requires its isolated Host`);
      return { args: ['run', '--root', root, '--workspace', ctx.workspace], stdinText: ctx.prompt };
    },
  });
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

async function configureOpencode(ctx) {
  const config = join(ctx.isolatedDir, 'opencode.json');
  Object.assign(ctx.env, {
    OPENCODE_CONFIG: config, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENAI_API_KEY: ctx.apiKey,
  });
  await jsonFile(config, {
    model: `mock/${ctx.model}`,
    providers: { mock: {
      name: 'Benchmark mock', package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: ctx.v1, apiKey: '{env:OPENAI_API_KEY}' },
      models: { [ctx.model]: { name: ctx.model } },
    } },
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    ...(ctx.mcp ? { mcp: { servers: { bench: {
      type: 'local', codemode: false, command: [ctx.mcp.command, ...ctx.mcp.args],
    } } } } : {}),
  });
}

function opencodeAdapter(attach) {
  return adapter({
    id: attach ? 'opencode-attach' : 'opencode-cold', harness: 'opencode', supportedTracks: both,
    installHint: 'Install OpenCode v2 (opencode on PATH).',
    ...(attach ? {
      async start(ctx) {
        await configureOpencode(ctx);
        const password = randomBytes(24).toString('hex');
        ctx.env.OPENCODE_PASSWORD = password;
        const state = await startChild(ctx.command, ['serve', '--hostname', '127.0.0.1', '--port', '0'], ctx,
          line => /https?:\/\/127\.0\.0\.1:[1-9][0-9]*/.exec(line)?.[0]);
        return { ...state, isolatedDir: ctx.isolatedDir, password };
      },
    } : {}),
    async prepare(ctx) {
      let server = ['--standalone'];
      if (attach) {
        if (ctx.daemonState?.isolatedDir !== ctx.isolatedDir) {
          throw new Error('opencode-attach requires its isolated daemon');
        }
        ctx.env.OPENCODE_PASSWORD = ctx.daemonState.password;
        server = ['--server', ctx.daemonState.value];
      } else {
        await configureOpencode(ctx);
      }
      return { args: ['run', ...server, '--model', `mock/${ctx.model}`, '--format', 'json', '--', ctx.prompt] };
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

const piDurable = adapter({
  id: 'pi-durable', locate: () => process.execPath,
  installHint: `Install ${durablePackages.join(' ')} in a directory and set HARNESS_BENCH_PI_DURABLE_DIR to it.`,
  async version(env, repoRoot, invocation) {
    const entries = await durableEntries(env, repoRoot, invocation);
    const path = join(dirname(fileURLToPath(entries.Harness)), '../package.json');
    return JSON.parse(await readFile(path, 'utf8')).version;
  },
  async prepare(ctx) {
    const entries = await durableEntries(ctx.source, ctx.repoRoot, {
      env: ctx.env, timeout: 8_000,
    });
    const path = join(ctx.isolatedDir, 'pi-durable-driver.mjs');
    ctx.env.OPENAI_API_KEY = ctx.apiKey;
    const { model, v1, sessionId, workspace, isolatedDir } = ctx;
    await privateFile(path, `import { readFileSync } from 'node:fs';
import { Harness, AssistantEntry, createRegistry } from ${toml(entries.Harness)};
import { openNodeSqliteStorage } from ${toml(entries.sqlite)};
import { createCodingTools } from ${toml(entries.tools)};
import { NodeExecutionEnv } from ${toml(entries.environment)};
import { createModels, createProvider, envApiKeyAuth } from ${toml(entries.ai)};
import { openAICompletionsApi } from ${toml(entries.completions)};
import { BACKGROUND_CONTEXT as context } from ${toml(entries.context)};

const modelId = ${toml(model)};
const baseUrl = ${toml(v1)};
const models = createModels();
models.setProvider(createProvider({
  id: 'mock', name: 'Benchmark mock', baseUrl,
  auth: { apiKey: envApiKeyAuth('Benchmark mock', ['OPENAI_API_KEY']) },
  api: openAICompletionsApi(),
  models: [{
    id: modelId, name: modelId, api: 'openai-completions', provider: 'mock', baseUrl,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 8192,
  }],
}));
const registry = createRegistry();
registry.install(createCodingTools());
const cwd = ${toml(workspace)};
const harness = await Harness.open(await openNodeSqliteStorage(${toml(join(isolatedDir, 'pi-durable.sqlite'))}), {
  models, registry, env: () => new NodeExecutionEnv({ cwd }),
}, context);
try {
  const root = await harness.root(context, { agent: { model: { provider: 'mock', modelId }, cwd } });
  const submission = await root.submit({
    type: 'input', content: readFileSync(0, 'utf8'), requestId: ${toml(sessionId)},
  }, context);
  harness.resume();
  const settled = await submission.wait(context);
  if (settled.status !== 'done' || settled.type !== 'input') {
    throw new Error('pi-durable did not produce an answer: ' + JSON.stringify(settled));
  }
  const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
  const text = answer?.model?.flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('');
  if (!text) throw new Error('pi-durable returned an empty answer');
  console.log(text);
} finally {
  await harness.close(context);
}
`);
    return { args: [path], stdinText: ctx.prompt };
  },
});

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
          providerModelRules: [{ ...selection, config: { enabled: true, properties: { contextWindow: 128000 } } }],
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
        `model = ${toml(ctx.model)}`, 'max_context_size = 128000', '',
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
  codexAdapter(true), codexAdapter(false), opencodeAdapter(false), opencodeAdapter(true),
  pi, piDurable, dim, dsh, zcode,
  kimiAdapter('kimi-openai', chat, 'openai'),
  kimiAdapter('kimi-responses', responses, 'openai_responses'),
  kimiAdapter('kimi-anthropic', anthropic, 'anthropic'),
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
  constructor(message, { status, provider, retryAfter, cause, disconnected } = {}) {
    super(message, { cause });
    this.status = status;
    this.provider = provider;
    this.retryAfter = retryAfter;
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
      const retryAfter = !error.retryAfter ? 0 : Number.isFinite(seconds)
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
    for (let round = 0; round < 100; round++) {
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
    throw new Error('Reference agent exceeded its 100-turn budget');
  } finally {
    await shared?.close();
  }
}

if (process.argv[2] === '--ref-agent' && process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    await runRefAgentCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
