import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCliReleaseArtifactMetrics } from './release-cli-artifact-policy.mjs';
import { npmSpawnOptions } from './npm-spawn.mjs';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 90_000;
const RUNTIME_HOST_SHUTDOWN_TIMEOUT_MS = 45_000;
const MODEL_ID = 'maka-release-smoke-model';
const CONNECTION_SLUG = 'maka-release-smoke';
const API_KEY = 'maka-release-smoke-key';
const FILE_SENTINEL = 'MAKA_RELEASE_FILESYSTEM_WORKER_OK';
const RESPONSE_SENTINEL = 'MAKA_RELEASE_SMOKE_OK';

const repoRoot = resolve(import.meta.dirname, '..');
const cliVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'),
).version;
const tarballPath = resolve(
  process.argv[2] ?? join(repoRoot, `packages/cli/release/maka-agent-${cliVersion}.tgz`),
);

await main();
// ConPTY may retain its native event-loop handle after every PTY child has
// emitted onExit. All product processes and temporary state are settled above,
// so terminate the verifier explicitly only on that platform.
if (process.platform === 'win32') process.exit(0);

async function main() {
  validateReleaseArtifact(tarballPath);
  const root = mkdtempSync(join(tmpdir(), 'maka-cli-tarball-smoke-'));
  try {
    const prefix = join(root, 'prefix');
    const cache = join(root, 'empty-npm-cache');
    execFileSync(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--cache',
        cache,
        '--offline',
        '--no-audit',
        '--no-fund',
        tarballPath,
      ],
      npmSpawnOptions({
        cwd: root,
        env: { ...process.env, npm_config_registry: 'http://127.0.0.1:9/' },
        stdio: 'inherit',
      }),
    );

    const packageRoot =
      process.platform === 'win32'
        ? join(prefix, 'node_modules/maka-agent')
        : join(prefix, 'lib/node_modules/maka-agent');
    const baseEnvironment = isolatedEnvironment(join(root, 'home'));
    const maka = process.platform === 'win32' ? join(prefix, 'maka.cmd') : join(prefix, 'bin/maka');
    const makaAgent =
      process.platform === 'win32'
        ? join(prefix, 'maka-agent.cmd')
        : join(prefix, 'bin/maka-agent');
    const cliEntrypoint = join(packageRoot, 'dist/cli.js');
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

    const version = runSync(maka, ['--version'], baseEnvironment, root).trim();
    if (version !== manifest.version) {
      throw new Error(`Installed CLI reports ${version}; package manifest is ${manifest.version}`);
    }
    assertOutput(runSync(maka, ['--help'], baseEnvironment, root), 'Usage: maka');
    assertOutput(runSync(makaAgent, ['--help'], baseEnvironment, root), 'Usage: maka');
    assertOutput(runSync(maka, ['eval', '--help'], baseEnvironment, root), 'usage: maka eval run');
    validateInstalledRuntimeFiles(packageRoot);

    const nodePty = await importInstalled(packageRoot, 'node_modules/node-pty/lib/index.js');
    const ptySpawn = nodePty.spawn ?? nodePty.default?.spawn;
    if (typeof ptySpawn !== 'function') throw new Error('Installed node-pty has no spawn function');
    await smokePty(ptySpawn, baseEnvironment, root);
    await smokeNativeFileLock(packageRoot, root);
    await smokeInteractiveTui({
      packageRoot,
      cliEntrypoint,
      ptySpawn,
      root: join(root, 'first-run'),
    });
    await smokeRuntimeHostService({
      packageRoot,
      cliEntrypoint,
      ptySpawn,
      root: join(root, 'runtime-host-service'),
    });
    await smokeControlledRun({
      packageRoot,
      cliEntrypoint,
      root: join(root, 'controlled-run'),
    });

    console.log(
      `[release-cli-smoke] OK — installed ${basename(tarballPath)} offline as ${version}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateReleaseArtifact(path) {
  if (!existsSync(path)) throw new Error(`Release tarball does not exist: ${path}`);
  const checksumPath = `${path}.sha256`;
  const inventoryPath = `${path}.files.json`;
  if (!existsSync(checksumPath) || !existsSync(inventoryPath)) {
    throw new Error('Release tarball checksum or file inventory is missing');
  }
  const checksum = readFileSync(checksumPath, 'utf8').trim().split(/\s+/u);
  if (checksum.length !== 2 || checksum[1] !== basename(path)) {
    throw new Error('Release tarball checksum sidecar is malformed');
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (checksum[0] !== actual) throw new Error('Release tarball checksum does not match');

  const files = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  if (!Array.isArray(files)) throw new Error('Release tarball file inventory must be an array');
  let unpackedBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || typeof file.path !== 'string') {
      throw new Error('Release tarball file inventory contains an invalid entry');
    }
    unpackedBytes += file.size;
  }
  validateCliReleaseArtifactMetrics({
    compressedBytes: statSync(path).size,
    unpackedBytes,
    entryCount: files.length,
  });
}

function validateInstalledRuntimeFiles(packageRoot) {
  for (const path of [
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'node_modules/@maka/eval/dist/index.js',
    'packages/eval/harbor/relay_agent.py',
    'packages/eval/harbor/egress-proxy/network-policy',
  ]) {
    if (!existsSync(join(packageRoot, path))) {
      throw new Error(`Installed runtime file is missing: ${path}`);
    }
  }
  assertOutput(
    readFileSync(join(packageRoot, 'node_modules/node-pty/lib/unixTerminal.js'), 'utf8'),
    'CustomWriteStream.prototype._ownsFileDescriptor',
  );
  assertOutput(
    readFileSync(join(packageRoot, 'node_modules/@ai-sdk/provider-utils/dist/index.js'), 'utf8'),
    'function absentIfBlank',
  );
}

async function smokePty(ptySpawn, environment, cwd) {
  const result = await runPtyScenario({
    ptySpawn,
    command: process.execPath,
    args: ['-e', 'process.stdout.write("maka-pty-ok")'],
    cwd,
    environment,
    marker: 'maka-pty-ok',
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(`Installed PTY exited with ${result.exitCode}`);
}

async function smokeNativeFileLock(packageRoot, root) {
  const imported = await importInstalled(packageRoot, 'node_modules/fs-native-extensions/index.js');
  const native = imported.default ?? imported;
  if (typeof native.tryLock !== 'function' || typeof native.unlock !== 'function') {
    throw new Error('Installed fs-native-extensions lock API is unavailable');
  }
  const lockPath = join(root, 'native-lock');
  const handle = openSync(lockPath, 'a+');
  try {
    if (native.tryLock(handle) !== true) throw new Error('Native file lock was not granted');
    native.unlock(handle);
  } finally {
    closeSync(handle);
  }
}

async function smokeInteractiveTui({ packageRoot, cliEntrypoint, ptySpawn, root }) {
  mkdirSync(root, { recursive: true });
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const environment = isolatedEnvironment(home);
  const dataRoots = await resolveInstalledDataRoots(packageRoot, environment, home);
  let completed = false;
  try {
    const result = await runPtyScenario({
      ptySpawn,
      command: process.execPath,
      args: [cliEntrypoint],
      cwd: workspace,
      environment,
      marker: 'Set Up Provider',
      onOutput: (terminal, output) => {
        if (!output.includes('/setup    配置模型提供商')) return false;
        terminal.write('/setup\r');
        return true;
      },
      onMarker: (terminal) => {
        terminal.write('\x03');
        setTimeout(() => terminal.write('\x04'), 250);
      },
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) throw new Error(`Interactive TUI exited with ${result.exitCode}`);
    completed = true;
  } finally {
    await settleRuntimeHost(packageRoot, dataRoots.workspaceRoot, completed);
  }
}

async function smokeRuntimeHostService({ packageRoot, cliEntrypoint, ptySpawn, root }) {
  mkdirSync(root, { recursive: true });
  const environment = isolatedEnvironment(join(root, 'home'));
  let ready;
  let completed = false;
  try {
    const result = await runPtyScenario({
      ptySpawn,
      command: process.execPath,
      args: [cliEntrypoint, 'runtime-host', 'serve', '--root', root, '--json'],
      cwd: root,
      environment,
      marker: '"event":"runtime_host_ready"',
      onMarker: (terminal, output) => {
        const line = output
          .split(/\r?\n/u)
          .map((candidate) => candidate.trim())
          .find((candidate) => candidate.includes('"event":"runtime_host_ready"'));
        ready = line ? JSON.parse(line) : undefined;
        terminal.write('\x03');
      },
      timeoutMs: PROCESS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Runtime Host service exited with ${result.exitCode}`);
    }
    if (
      ready?.schemaVersion !== 1 ||
      ready.protocol?.version === undefined ||
      !ready.hostEpoch ||
      !ready.rootId ||
      !ready.listeners?.some((listener) => listener.kind === 'local_ipc')
    ) {
      throw new Error('Runtime Host ready event is incomplete');
    }
    completed = true;
  } finally {
    await settleRuntimeHost(packageRoot, root, completed);
  }
}

async function smokeControlledRun({ packageRoot, cliEntrypoint, root }) {
  mkdirSync(root, { recursive: true });
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'smoke.txt'), `${FILE_SENTINEL}\n`, 'utf8');
  const environment = isolatedEnvironment(home);
  const dataRoots = await resolveInstalledDataRoots(packageRoot, environment, home);
  const provider = await startProvider();
  let behaviorCompleted = false;
  try {
    await configureRuntimePolicy(packageRoot, dataRoots.workspaceRoot, provider.baseUrl);
    const result = await runProcess(
      process.execPath,
      [
        cliEntrypoint,
        'run',
        'Read smoke.txt, then report the exact release-smoke result.',
        '--cwd',
        workspace,
        '--connection',
        CONNECTION_SLUG,
        '--model',
        MODEL_ID,
        '--timeout',
        '45',
        '--max-steps',
        '4',
        '--yolo',
      ],
      {
        cwd: workspace,
        environment,
        timeoutMs: PROCESS_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Controlled maka run exited with ${result.exitCode}: ${result.stderr}`);
    }
    assertOutput(result.stdout, RESPONSE_SENTINEL);
    if (!provider.sawReadTool || !provider.sawFileSentinel) {
      throw new Error('Controlled maka run did not execute the installed filesystem worker');
    }
    if (provider.error) throw provider.error;
    behaviorCompleted = true;
  } finally {
    await provider.close();
    await settleRuntimeHost(packageRoot, dataRoots.workspaceRoot, behaviorCompleted);
  }
}

async function configureRuntimePolicy(packageRoot, rootPath, baseUrl) {
  const authority = await importInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/root-authority.js',
  );
  const policyModule = await importInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/runtime-policy-stores.js',
  );
  const capability = await authority.resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const owner = await authority.tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Unable to acquire the controlled-run Runtime Host root');
  try {
    const policy = await policyModule.openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const initial = await policy.connectionCatalog.getSnapshot();
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: initial.revision,
      connection: {
        slug: CONNECTION_SLUG,
        name: 'Maka release smoke',
        providerType: 'moonshot',
        baseUrl,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    if (created.kind !== 'committed') throw new Error(`Connection setup failed: ${created.kind}`);
    const connection = created.snapshot.connections.find(
      (candidate) => candidate.slug === CONNECTION_SLUG,
    );
    if (!connection) throw new Error('Connection setup omitted the controlled connection');
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: API_KEY,
    });
    if (credential.kind !== 'committed') {
      throw new Error(`Credential setup failed: ${credential.kind}`);
    }
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    if (fetch.kind !== 'ready') throw new Error(`Model setup failed: ${fetch.kind}`);
    const discovered = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [
        {
          id: MODEL_ID,
          capabilities: { chat: true, functionCalling: true },
          contextWindow: 8_192,
          maxOutputTokens: 256,
        },
      ],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    if (discovered.kind !== 'committed') {
      throw new Error(`Model setup commit failed: ${discovered.kind}`);
    }
    const defaulted = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: discovered.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: MODEL_ID },
    });
    if (defaulted.kind !== 'committed') {
      throw new Error(`Default model setup failed: ${defaulted.kind}`);
    }
  } finally {
    await owner.close();
  }
}

async function startProvider() {
  let streamRequestCount = 0;
  let sawReadTool = false;
  let sawFileSentinel = false;
  let providerError;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      providerError ??= error instanceof Error ? error : new Error(String(error));
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('release smoke provider failure');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind TCP');

  async function handleRequest(request, response) {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST') throw new Error(`Unexpected provider method: ${request.method}`);
    if (request.headers.authorization !== `Bearer ${API_KEY}`) {
      throw new Error('Controlled provider received the wrong authorization header');
    }
    const body = JSON.parse(await readRequestBody(request));
    if (body.stream !== true) {
      respondNonStreaming(response);
      return;
    }
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    if (toolNames.includes('Read')) {
      streamRequestCount += 1;
      if (streamRequestCount === 1) {
        sawReadTool = true;
        respondToolCall(response, 'Read', { path: 'smoke.txt' });
        return;
      }
      sawFileSentinel ||= JSON.stringify(body).includes(FILE_SENTINEL);
      if (!sawFileSentinel) throw new Error('Read tool result did not contain the smoke file');
    }
    respondText(response, RESPONSE_SENTINEL);
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get sawReadTool() {
      return sawReadTool;
    },
    get sawFileSentinel() {
      return sawFileSentinel;
    },
    get error() {
      return providerError;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function respondToolCall(response, name, args) {
  respondSse(response, [
    {
      id: 'chatcmpl-release-smoke-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'release-smoke-read',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-release-smoke-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

function respondText(response, text) {
  respondSse(response, [
    {
      id: 'chatcmpl-release-smoke-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-release-smoke-text',
      object: 'chat.completion.chunk',
      created: 2,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  ]);
}

function respondSse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function respondNonStreaming(response) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-release-smoke-summary',
      object: 'chat.completion',
      created: 3,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: RESPONSE_SENTINEL },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

async function readRequestBody(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_OUTPUT_BYTES)
      throw new Error('Provider request is too large');
  }
  return body;
}

async function resolveInstalledDataRoots(packageRoot, environment, home) {
  const storage = await importInstalled(packageRoot, 'node_modules/@maka/storage/dist/index.js');
  return storage.resolveMakaDataRoots({ env: environment, homeDir: home, profileName: 'Maka' });
}

async function waitForRuntimeHostShutdown(packageRoot, rootPath) {
  const authority = await importInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/root-authority.js',
  );
  const capability = await authority.resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const { controlDirectory } = await authority.prepareStorageRootControlDirectory(capability);
  const registrationPath = join(controlDirectory, 'registration.json');
  const deadline = Date.now() + RUNTIME_HOST_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!existsSync(registrationPath)) {
      const owner = await authority.tryAcquireInteractiveRootOwner(capability);
      if (owner) {
        await owner.close();
        return;
      }
    }
    await delay(100);
  }
  throw new Error(`Runtime Host did not release its root: ${rootPath}`);
}

async function settleRuntimeHost(packageRoot, rootPath, requireNaturalShutdown) {
  try {
    await waitForRuntimeHostShutdown(packageRoot, rootPath);
    return;
  } catch (error) {
    if (requireNaturalShutdown) throw error;
  }
  const authority = await importInstalled(
    packageRoot,
    'node_modules/@maka/storage/dist/root-authority.js',
  );
  const capability = await authority.resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const { controlDirectory } = await authority.prepareStorageRootControlDirectory(capability);
  const registrationPath = join(controlDirectory, 'registration.json');
  if (!existsSync(registrationPath)) return;
  const registration = JSON.parse(readFileSync(registrationPath, 'utf8'));
  if (
    registration.rootId !== capability.rootId ||
    !Number.isSafeInteger(registration.pid) ||
    registration.pid <= 0
  ) {
    throw new Error('Refusing to clean up a Runtime Host with an unexpected registration');
  }
  try {
    process.kill(registration.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processExists(registration.pid)) await delay(100);
  if (processExists(registration.pid)) {
    try {
      process.kill(registration.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function runPtyScenario({
  ptySpawn,
  command,
  args,
  cwd,
  environment,
  marker,
  onOutput,
  onMarker,
  timeoutMs,
}) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    let markerSeen = false;
    let outputActionApplied = false;
    let settled = false;
    const terminal = ptySpawn(command, args, {
      cwd,
      env: environment,
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminal.kill();
      reject(
        new Error(
          `PTY command timed out waiting for ${JSON.stringify(marker)}: ${output.slice(-4_000)}`,
        ),
      );
    }, timeoutMs);
    terminal.onData((chunk) => {
      if (settled) return;
      try {
        output = appendBounded(output, chunk);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        terminal.kill();
        reject(error);
        return;
      }
      if (!outputActionApplied && onOutput) {
        try {
          outputActionApplied = onOutput(terminal, output) === true;
        } catch (error) {
          settled = true;
          clearTimeout(timer);
          terminal.kill();
          reject(error);
          return;
        }
      }
      if (!markerSeen && output.includes(marker)) {
        markerSeen = true;
        try {
          onMarker?.(terminal, output);
        } catch (error) {
          settled = true;
          clearTimeout(timer);
          terminal.kill();
          reject(error);
        }
      }
    });
    terminal.onExit(({ exitCode, signal }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!markerSeen) {
        reject(new Error(`PTY command exited before ${JSON.stringify(marker)}: ${output}`));
        return;
      }
      resolvePromise({ exitCode, signal, output });
    });
  });
}

function runProcess(command, args, { cwd, environment, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.once('error', (error) => {
      fail(error);
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        return;
      }
      resolvePromise({ exitCode, signal, stdout, stderr });
    });
  });
}

function isolatedEnvironment(home) {
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  const temporaryDirectory = join(home, 'tmp');
  for (const path of [home, appData, localAppData, join(home, '.config'), temporaryDirectory]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    NODE_PATH: '',
    TERM: 'xterm-256color',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

function importInstalled(packageRoot, relativePath) {
  return import(pathToFileURL(join(packageRoot, relativePath)).href);
}

function runSync(command, args, environment, cwd) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  });
}

function appendBounded(previous, chunk) {
  const next = previous + chunk;
  if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
    throw new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes`);
  }
  return next;
}

function assertOutput(output, marker) {
  if (!output.includes(marker)) {
    throw new Error(`Expected output to contain ${JSON.stringify(marker)}`);
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}
