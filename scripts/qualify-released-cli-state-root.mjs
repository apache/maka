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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';

const PROCESS_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const fixturePath = fileURLToPath(
  new URL('./released-cli-state-root-fixture.mjs', import.meta.url),
);
const qualificationPath = fileURLToPath(import.meta.url);
const SUDO_BWRAP_ENV = 'MAKA_QUALIFICATION_BWRAP_USE_SUDO';

export function parseQualificationArgs(argv) {
  const allowedNames = new Set([
    '--source',
    '--target',
    '--source-sha256',
    '--target-sha256',
    '--target-workspace',
    '--expect-epoch-relation',
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Qualification arguments must be --name value pairs');
    }
    if (!allowedNames.has(name)) throw new Error(`Unknown qualification argument: ${name}`);
    if (values.has(name)) throw new Error(`Duplicate qualification argument: ${name}`);
    values.set(name, value);
  }
  const source = requireAbsolutePath(values, '--source');
  const sourceSha256 = requireSha256(values, '--source-sha256');
  const expectedEpochRelation = values.get('--expect-epoch-relation') ?? 'any';
  if (!['same', 'different', 'any'].includes(expectedEpochRelation)) {
    throw new Error('Expected epoch relation must be same, different, or any');
  }
  // A pull request qualifies the built workspace rather than a packaged
  // artifact: what decides whether durable state still opens is the compiled
  // storage and Runtime Host code, and packaging only moves it. The release
  // lanes keep naming an exact tarball, which is why identity stays required
  // there rather than optional everywhere.
  if (values.has('--target-workspace')) {
    if (values.has('--target') || values.has('--target-sha256')) {
      throw new Error('A workspace target cannot also name a tarball target');
    }
    return {
      source,
      sourceSha256,
      targetWorkspace: requireAbsolutePath(values, '--target-workspace'),
      expectedEpochRelation,
    };
  }
  const target = requireAbsolutePath(values, '--target');
  const targetSha256 = requireSha256(values, '--target-sha256');
  return { source, target, sourceSha256, targetSha256, expectedEpochRelation };
}

export function assertExpectedEpochRelation(sourceEpoch, targetEpoch, expected) {
  if (!Number.isSafeInteger(sourceEpoch) || !Number.isSafeInteger(targetEpoch)) {
    throw new Error('Release compatibility epochs must be safe integers');
  }
  const actual = sourceEpoch === targetEpoch ? 'same' : 'different';
  if (expected !== 'any' && expected !== actual) {
    throw new Error(`Expected ${expected} compatibility epochs, found ${actual}`);
  }
  return actual;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function qualificationSandboxInvocation({ args, account, useSudo }) {
  if (!useSudo) return { command: 'bwrap', args };
  const separator = args.indexOf('--');
  if (separator === -1) throw new Error('Qualification sandbox command is missing');
  return {
    command: 'sudo',
    args: [
      '--non-interactive',
      '--',
      '/usr/bin/bwrap',
      ...args.slice(0, separator),
      '--cap-add',
      'CAP_SETUID',
      '--cap-add',
      'CAP_SETGID',
      '--cap-add',
      'CAP_SETPCAP',
      '--',
      '/usr/bin/setpriv',
      '--regid',
      String(account.gid),
      '--reuid',
      String(account.uid),
      '--clear-groups',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--bounding-set=-all',
      '--no-new-privs',
      ...args.slice(separator + 1),
    ],
  };
}

export async function qualifyReleasedCliStateRoot(input) {
  if (process.platform !== 'linux') {
    throw new Error('Released State Root qualification currently requires Linux');
  }
  assertCommandAvailable('bwrap');
  assertCommandAvailable('timeout');
  const useSudo = parseSudoBwrapEnvironment(process.env[SUDO_BWRAP_ENV]);
  if (useSudo) {
    assertCommandAvailable('sudo');
    assertCommandAvailable('/usr/bin/setpriv');
  }
  assertTarballDigest(input.source, input.sourceSha256, 'source');
  if (!input.targetWorkspace) {
    assertTarballDigest(input.target, input.targetSha256, 'target');
  }
  const scope = mkdtempSync(join(tmpdir(), 'maka-released-state-root-'));
  try {
    const sandbox = prepareSandbox(scope);
    const source = installArtifact({
      role: 'source',
      tarball: input.source,
      scope,
      sandbox,
    });
    const target = input.targetWorkspace
      ? workspaceArtifact({ repoRoot: input.targetWorkspace, scope, sandbox })
      : installArtifact({
          role: 'target',
          tarball: input.target,
          scope,
          sandbox,
        });
    const epochRelation = assertExpectedEpochRelation(
      source.compatibilityEpoch,
      target.compatibilityEpoch,
      input.expectedEpochRelation,
    );
    const innerInputPath = join(scope, 'qualification-input.json');
    writeFileSync(
      innerInputPath,
      `${JSON.stringify({
        scope,
        source,
        target,
        sourceSha256: input.sourceSha256,
        targetSha256: input.targetSha256,
        epochRelation,
      })}\n`,
      { mode: 0o600 },
    );
    return runQualificationSandbox({ innerInputPath, sandbox, scope, useSudo });
  } finally {
    rmSync(scope, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// The State Root is not the whole durable surface. The Runtime Host access file
// and the rest of the control records live in the account-local control
// namespace, and the Host opens them before the Kernel starts — so a golden
// copy that captured only the State Root could not restore, or observe, the
// state that decides whether the Host starts at all. The control path mirrors
// resolveRootControlNamespace in @maka/storage; this harness runs on Linux
// only, so it names the Linux location rather than importing across the
// installed artifacts it is here to compare.
export function durableStateLocations(scope) {
  return [
    { live: join(scope, 'state-root'), golden: join(scope, 'golden-root') },
    {
      live: join(userInfo().homedir, '.cache', 'maka', 'runtime-hosts'),
      golden: join(scope, 'golden-control'),
    },
  ];
}

async function qualifyInstalledArtifacts(input) {
  const { scope, source, target } = input;
  const locations = durableStateLocations(scope);
  const rootPath = locations[0].live;
  mkdirSync(rootPath, { recursive: true });
  const seeded = runFixture({ action: 'seed', artifact: source, rootPath, scope });
  assertFacts(seeded);
  captureGolden(locations);

  const sourceReady = await runInstalledRuntimeHost({ artifact: source, rootPath, scope });
  const sourceFacts = runFixture({ action: 'inspect', artifact: source, rootPath, scope });
  assertSameFacts(seeded, sourceFacts, 'source self-reopen');

  restoreGolden(locations);
  const writerFence = await proveWriterFence({ source, target, rootPath, scope });

  restoreGolden(locations);
  const targetReady = await runInstalledRuntimeHost({ artifact: target, rootPath, scope });
  const targetFacts = runFixture({ action: 'inspect', artifact: target, rootPath, scope });
  assertSameFacts(seeded, targetFacts, 'target transition');

  return {
    schemaVersion: 1,
    source: artifactEvidence(source, input.sourceSha256),
    target: artifactEvidence(target, input.targetSha256),
    epochRelation: input.epochRelation,
    facts: seeded,
    checks: {
      sourceSelfReopen: { kind: 'passed', host: sourceReady },
      concurrentWriterFence: writerFence,
      targetTransition: { kind: 'passed', host: targetReady },
    },
    claims: {
      rollback: 'not_claimed',
      downgrade: 'unsupported',
      externalNpmReconciliation: 'not_qualified_by_this_harness',
    },
  };
}

function requireAbsolutePath(values, name) {
  const value = values.get(name);
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function requireSha256(values, name) {
  const value = values.get(name);
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256`);
  }
  return value;
}

function assertTarballDigest(path, expected, role) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_TARBALL_BYTES) {
    throw new Error(`The ${role} release tarball exceeds the qualification boundary`);
  }
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(`The ${role} release tarball SHA-256 does not match`);
  }
}

function assertCommandAvailable(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is required`);
  if (result.status !== 0) throw new Error(`${command} is unavailable`);
}

function prepareSandbox(scope) {
  const account = userInfo();
  const home = join(scope, 'home');
  const temp = join(scope, 'tmp');
  const etc = join(scope, 'etc');
  for (const path of [home, temp, etc]) mkdirSync(path, { recursive: true });
  const passwd = join(etc, 'passwd');
  const group = join(etc, 'group');
  writeFileSync(
    passwd,
    `maka-qualification:x:${account.uid}:${account.gid}:Maka qualification:${home}:/bin/sh\n`,
  );
  writeFileSync(group, `maka-qualification:x:${account.gid}:\n`);
  return {
    account,
    home,
    temp,
    passwd,
    group,
    environment: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      TMPDIR: temp,
    },
  };
}

function parseSudoBwrapEnvironment(value) {
  if (value === undefined || value === '') return false;
  if (value === '1') return true;
  throw new Error(`${SUDO_BWRAP_ENV} must be 1 when set`);
}

function installArtifact({ role, tarball, scope, sandbox }) {
  const prefix = join(scope, `${role}-prefix`);
  const cache = join(scope, `${role}-npm-cache`);
  const result = spawnSync(
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
      tarball,
    ],
    npmSpawnOptions({
      cwd: scope,
      env: {
        ...sandbox.environment,
        npm_config_registry: 'http://127.0.0.1:9/',
      },
      encoding: 'utf8',
    }),
  );
  if (result.status !== 0) {
    throw new Error(`Unable to install the ${role} release tarball: ${result.stderr}`);
  }
  const packageRoot = join(prefix, 'lib/node_modules/maka-agent');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const protocolPath = join(packageRoot, 'node_modules/@maka/runtime-host/dist/protocol/index.js');
  const protocol = readFileSync(protocolPath, 'utf8');
  const epoch = protocol.match(/RUNTIME_HOST_COMPATIBILITY_EPOCH\s*=\s*(\d+)/u)?.[1];
  if (!epoch) throw new Error(`The ${role} release has no compatibility epoch`);
  const cliPath = join(packageRoot, 'dist/cli.js');
  const versionResult = spawnSync(process.execPath, [cliPath, '--version'], {
    cwd: scope,
    env: sandbox.environment,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
  });
  if (versionResult.status !== 0) {
    throw new Error(`The ${role} CLI version check failed: ${versionResult.stderr}`);
  }
  const version = versionResult.stdout.trim();
  if (version !== manifest.version) {
    throw new Error(`The ${role} CLI reports ${version}; expected ${manifest.version}`);
  }
  return { role, prefix, packageRoot, cliPath, version, compatibilityEpoch: Number(epoch) };
}

// The workspace already carries the compiled packages the fixture loads: npm
// workspaces link node_modules/@maka/* at the repository root, which is the
// same shape an installed tarball presents. Nothing is installed, so the
// packaging chain in front of this check is skipped entirely.
function workspaceArtifact({ repoRoot, scope, sandbox }) {
  const cliPath = join(repoRoot, 'packages/cli/dist/cli.js');
  const protocolPath = join(repoRoot, 'node_modules/@maka/runtime-host/dist/protocol/index.js');
  for (const required of [cliPath, protocolPath]) {
    if (!existsSync(required)) {
      throw new Error(`The workspace target is not built: ${required} is missing`);
    }
  }
  const epoch = readFileSync(protocolPath, 'utf8').match(
    /RUNTIME_HOST_COMPATIBILITY_EPOCH\s*=\s*(\d+)/u,
  )?.[1];
  if (!epoch) throw new Error('The workspace target has no compatibility epoch');
  const versionResult = spawnSync(process.execPath, [cliPath, '--version'], {
    cwd: scope,
    env: sandbox.environment,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
  });
  if (versionResult.status !== 0) {
    throw new Error(`The workspace CLI version check failed: ${versionResult.stderr}`);
  }
  return {
    role: 'target',
    kind: 'workspace',
    packageRoot: repoRoot,
    cliPath,
    version: versionResult.stdout.trim(),
    compatibilityEpoch: Number(epoch),
  };
}

export function qualificationSandboxArgs({ innerInputPath, sandbox, scope }) {
  return [
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--tmpfs',
    '/tmp',
    '--chmod',
    '1777',
    '/tmp',
    '--bind',
    scope,
    scope,
    '--ro-bind',
    sandbox.passwd,
    '/etc/passwd',
    '--ro-bind',
    sandbox.group,
    '/etc/group',
    '--setenv',
    'HOME',
    sandbox.home,
    '--setenv',
    'XDG_CACHE_HOME',
    sandbox.environment.XDG_CACHE_HOME,
    '--setenv',
    'XDG_CONFIG_HOME',
    sandbox.environment.XDG_CONFIG_HOME,
    '--setenv',
    'XDG_DATA_HOME',
    sandbox.environment.XDG_DATA_HOME,
    '--setenv',
    'TMPDIR',
    sandbox.temp,
    '--chdir',
    scope,
    '--',
    process.execPath,
    qualificationPath,
    '--inner',
    innerInputPath,
  ];
}

function runQualificationSandbox({ innerInputPath, sandbox, scope, useSudo }) {
  const invocation = qualificationSandboxInvocation({
    args: qualificationSandboxArgs({ innerInputPath, sandbox, scope }),
    account: sandbox.account,
    useSudo,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: scope,
    env: sandbox.environment,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS * 4,
  });
  if (result.status !== 0) {
    throw new Error(`Qualification sandbox failed: ${result.stderr || result.stdout}`);
  }
  return parseLastJsonLine(result.stdout);
}

function runFixture({ action, artifact, rootPath, scope }) {
  const result = spawnSync(
    process.execPath,
    [fixturePath, '--action', action, '--package-root', artifact.packageRoot, '--root', rootPath],
    {
      cwd: scope,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Released fixture failed: ${result.stderr || result.stdout}`);
  }
  return parseLastJsonLine(result.stdout);
}

async function proveWriterFence({ source, target, rootPath, scope }) {
  const result = spawnSync(
    process.execPath,
    [
      fixturePath,
      '--action',
      'fence',
      '--package-root',
      source.packageRoot,
      '--root',
      rootPath,
      '--target-package-root',
      target.packageRoot,
    ],
    {
      cwd: scope,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Released writer-fence fixture failed: ${result.stderr || result.stdout}`);
  }
  const attempted = parseLastJsonLine(result.stdout);
  if (attempted.kind !== 'writer_fenced') {
    throw new Error('The target release acquired a concurrently held State Root writer');
  }
  return { kind: 'passed', rootId: attempted.rootId };
}

async function runInstalledRuntimeHost({ artifact, rootPath, scope }) {
  const configPath = join(scope, `${artifact.role}-runtime-host-service.json`);
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 2,
      rootPath,
      projectDirectoryRoots: [{ label: 'qualification', path: scope }],
      websocket: {
        host: '127.0.0.1',
        port: await allocateLoopbackPort(),
        path: '/runtime-host',
      },
      launch: { nodePath: process.execPath, cliPath: artifact.cliPath },
    })}\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    'timeout',
    [
      '--signal=INT',
      '--kill-after=15s',
      '--preserve-status',
      '10s',
      process.execPath,
      artifact.cliPath,
      'runtime-host',
      'serve',
      '--managed-service-config',
      configPath,
      '--json',
    ],
    {
      cwd: scope,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PROCESS_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Released Runtime Host failed: ${result.stderr || result.stdout}`);
  }
  const ready = findJsonLine(result.stdout, (value) => value.event === 'runtime_host_ready');
  if (!ready?.rootId || !ready.hostEpoch) {
    throw new Error(`The released Runtime Host did not publish Ready: ${result.stderr}`);
  }
  return { rootId: ready.rootId, hostEpoch: ready.hostEpoch };
}

function parseLastJsonLine(output) {
  const lines = output.trim().split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Earlier lines may contain runtime diagnostics.
    }
  }
  throw new Error('Released fixture produced no JSON evidence');
}

function findJsonLine(output, predicate) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (predicate(value)) return value;
    } catch {
      // Non-JSON diagnostics remain outside the evidence channel.
    }
  }
  return undefined;
}

function assertFacts(value) {
  if (
    value.kind !== 'facts' ||
    !value.rootId ||
    !value.session?.id ||
    !value.session?.message?.id ||
    !value.scheduledTask?.id ||
    !value.access?.credentialId
  ) {
    throw new Error('Released fixture evidence is incomplete');
  }
}

function assertSameFacts(expected, actual, stage) {
  assertFacts(actual);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Durable facts changed during ${stage}`);
  }
}

function captureGolden(locations) {
  for (const { live, golden } of locations) {
    rmSync(golden, { recursive: true, force: true });
    if (!existsSync(live)) continue;
    cpSync(live, golden, { recursive: true, force: true });
  }
}

function restoreGolden(locations) {
  for (const { live, golden } of locations) {
    if (existsSync(live)) {
      for (const entry of readdirSync(live)) {
        rmSync(join(live, entry), { recursive: true, force: true });
      }
    }
    if (!existsSync(golden)) continue;
    mkdirSync(live, { recursive: true });
    for (const entry of readdirSync(golden)) {
      cpSync(join(golden, entry), join(live, entry), {
        recursive: true,
        force: true,
      });
    }
  }
}

function artifactEvidence(artifact, sha256) {
  // A workspace target has no published identity to pin, and saying so keeps
  // this report from reading as evidence about a release it never touched.
  if (artifact.kind === 'workspace') {
    return {
      version: artifact.version,
      compatibilityEpoch: artifact.compatibilityEpoch,
      kind: 'workspace',
      sha256: 'not_applicable',
    };
  }
  return {
    version: artifact.version,
    compatibilityEpoch: artifact.compatibilityEpoch,
    sha256,
  };
}

async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a port');
  return address.port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--inner') {
      const innerInputPath = process.argv[3];
      if (!innerInputPath || !isAbsolute(innerInputPath) || process.argv.length !== 4) {
        throw new Error('Qualification sandbox requires one absolute input path');
      }
      const report = await qualifyInstalledArtifacts(
        JSON.parse(readFileSync(innerInputPath, 'utf8')),
      );
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      const report = await qualifyReleasedCliStateRoot(
        parseQualificationArgs(process.argv.slice(2)),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
