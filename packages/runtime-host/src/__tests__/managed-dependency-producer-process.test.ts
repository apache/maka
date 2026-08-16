import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as runtimeHostServer from '../server/index.js';
import { resolveBundledNpmRuntime } from '../server/bundled-npm-runtime.js';
import {
  isManagedNpmNodeVersionSupported,
  runManagedDependencyProducerProcessInternal,
  runManagedNpmDependencyProvision,
} from '../server/managed-dependency-producer-process.js';

const productionProfileSkip = isManagedNpmNodeVersionSupported(process.versions.node)
  ? false
  : `Host Node ${process.versions.node} is outside the attested managed npm profile`;

test('keeps npm attestation and provisioning package-internal until composition owns both', () => {
  assert.equal('resolveBundledNpmRuntime' in runtimeHostServer, false);
  assert.equal('runManagedNpmDependencyProvision' in runtimeHostServer, false);
});

test('rejects a structurally valid but unissued npm runtime capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-npm-forged-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);

  await assert.rejects(
    runManagedNpmDependencyProvision({
      producerInput: fixtureProducerInput(outputRoot, scratchRoot),
      runtime: Object.freeze({
        npmVersion: '12.0.2',
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules ?? 'unknown',
        platform: process.platform,
        arch: process.arch,
        nodeExecutablePath: process.execPath,
        npmRuntimeRoot: root,
        npmCliPath: join(root, 'npm-cli.js'),
        runtimeIdentitySha256: `sha256:${'6'.repeat(64)}`,
      }),
    } as never),
    /attested runtime capability/u,
  );
});

test('admits only Node versions compatible with the fixed npm execution profile', () => {
  assert.equal(isManagedNpmNodeVersionSupported('22.22.1'), false);
  assert.equal(isManagedNpmNodeVersionSupported('22.22.2'), true);
  assert.equal(isManagedNpmNodeVersionSupported('23.99.0'), false);
  assert.equal(isManagedNpmNodeVersionSupported('24.14.9'), false);
  assert.equal(isManagedNpmNodeVersionSupported('24.15.0'), true);
  assert.equal(isManagedNpmNodeVersionSupported('25.0.0'), false);
  assert.equal(isManagedNpmNodeVersionSupported('26.0.0'), true);
  assert.equal(isManagedNpmNodeVersionSupported('27.0.0'), false);
  assert.equal(isManagedNpmNodeVersionSupported('999.0.0'), false);
  assert.equal(isManagedNpmNodeVersionSupported('invalid'), false);
});

test('runs the fixed npm install protocol with a hermetic environment', {
  skip: productionProfileSkip,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-npm-provision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const npmCliPath = join(root, 'fixture-npm-cli.cjs');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);
  await writeFile(
    npmCliPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'fixture'), { recursive: true });",
      "fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fixture', 'index.js'), 'safe\\n');",
      "fs.writeFileSync(path.join(process.cwd(), 'invocation.json'), JSON.stringify({ args, env: process.env }));",
    ].join(''),
    'utf8',
  );
  const previousSecret = process.env.MAKA_DEPENDENCY_SECRET_FOR_TEST;
  process.env.MAKA_DEPENDENCY_SECRET_FOR_TEST = 'must-not-cross';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MAKA_DEPENDENCY_SECRET_FOR_TEST;
    else process.env.MAKA_DEPENDENCY_SECRET_FOR_TEST = previousSecret;
  });

  await runManagedNpmDependencyProvision({
    producerInput: fixtureProducerInput(outputRoot, scratchRoot),
    runtime: await attestFixtureRuntime(root, npmCliPath),
  });

  const invocation = JSON.parse(await readFile(join(projectRoot, 'invocation.json'), 'utf8')) as {
    args: string[];
    env: Record<string, string | undefined>;
  };
  assert.deepEqual(invocation.args.slice(0, 6), [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=true',
    `--cache=${join(scratchRoot, 'cache')}`,
  ]);
  assert.equal(invocation.env.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal(invocation.env.npm_config_ignore_scripts, 'true');
  assert.equal(invocation.env.NODE_DISABLE_COMPILE_CACHE, '1');
  assert.equal(invocation.env.NODE_COMPILE_CACHE, undefined);
  assert.equal(invocation.env.MAKA_DEPENDENCY_SECRET_FOR_TEST, undefined);
  if (process.platform === 'win32') {
    const relativeHome = join('.maka-runtime', 'home');
    assert.equal(invocation.env.HOME, relativeHome);
    assert.equal(invocation.env.USERPROFILE, relativeHome);
    assert.equal(invocation.env.APPDATA, join(relativeHome, 'AppData', 'Roaming'));
    assert.equal(invocation.env.LOCALAPPDATA, join(relativeHome, 'AppData', 'Local'));
  }
  assert.equal(await readFile(join(outputRoot, 'fixture', 'index.js'), 'utf8'), 'safe\n');
});

test('rejects lifecycle-script lock entries before starting npm', {
  skip: productionProfileSkip,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-npm-unsafe-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const npmCliPath = join(root, 'must-not-run.cjs');
  const marker = join(root, 'spawned');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);
  await writeFile(
    npmCliPath,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    'utf8',
  );
  const producerInput = fixtureProducerInput(outputRoot, scratchRoot);
  producerInput.lockfileBytes = Buffer.from(
    '{"lockfileVersion":3,"packages":{"":{"name":"fixture"},"node_modules/unsafe":{"resolved":"https://registry.npmjs.org/unsafe/-/unsafe-1.0.0.tgz","integrity":"sha512-YQ==","hasInstallScript":true}}}\n',
  );

  await assert.rejects(
    runManagedNpmDependencyProvision({
      producerInput,
      runtime: await attestFixtureRuntime(root, npmCliPath),
    }),
    /unsafe dependency entry/u,
  );
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('rejects a pre-positioned scratch redirect before starting npm', {
  skip: productionProfileSkip,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-npm-scratch-redirect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const outsideRoot = join(root, 'outside');
  const npmCliPath = join(root, 'must-not-run.cjs');
  const marker = join(root, 'spawned');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await symlink(
    outsideRoot,
    join(scratchRoot, 'home'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    npmCliPath,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
    'utf8',
  );

  await assert.rejects(
    runManagedNpmDependencyProvision({
      producerInput: fixtureProducerInput(outputRoot, scratchRoot),
      runtime: await attestFixtureRuntime(root, npmCliPath),
    }),
    /scratch entry was not created/u,
  );
  await assert.rejects(readFile(join(outsideRoot, 'npmrc'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('denies child-process creation inside the fixed npm execution profile', {
  skip: productionProfileSkip,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-npm-child-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const npmCliPath = join(root, 'spawning-npm-cli.cjs');
  const descendantMarker = join(root, 'descendant-ran');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);
  await writeFile(
    npmCliPath,
    [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, 'ran')`)}]);`,
    ].join(''),
    'utf8',
  );

  await assert.rejects(
    runManagedNpmDependencyProvision({
      producerInput: fixtureProducerInput(outputRoot, scratchRoot),
      runtime: await attestFixtureRuntime(root, npmCliPath),
    }),
    /child_process|permission|access denied/iu,
  );
  await assert.rejects(readFile(descendantMarker, 'utf8'), { code: 'ENOENT' });
});

test('waits for the producer process output tree to close before returning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-drain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'descendant-finished');
  const descendant = [
    "const { writeFileSync } = require('node:fs');",
    `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'done'); process.stdout.write('descendant done\\n'); }, 150);`,
  ].join('');
  const producer = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
    "process.stdout.write('producer done\\n');",
  ].join('');

  const result = await runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    timeoutMs: 5_000,
    maxObservedBytes: 1024 * 1024,
    maxObservedEntries: 100,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.outputTail, /producer done/u);
  assert.match(result.outputTail, /descendant done/u);
  assert.equal(await readFile(marker, 'utf8'), 'done');
});

test('aborts and reaps the complete producer process tree before rejecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidPath = join(root, 'child.pid');
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const producer = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const abort = new AbortController();
  const task = runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    abortSignal: abort.signal,
    timeoutMs: 5_000,
    maxObservedBytes: 1024 * 1024,
    maxObservedEntries: 100,
  });
  const childPid = Number.parseInt(await waitForFile(childPidPath), 10);

  abort.abort();

  await assert.rejects(task, /aborted/u);
  await waitForProcessExit(childPid);
});

test('reaps a surviving descendant after the direct producer accepts SIGTERM', {
  skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-root-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidPath = join(root, 'child.pid');
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const producer = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const abort = new AbortController();
  const task = runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    abortSignal: abort.signal,
    timeoutMs: 5_000,
    maxObservedBytes: 1024 * 1024,
    maxObservedEntries: 100,
  });
  const childPid = Number.parseInt(await waitForFile(childPidPath), 10);

  abort.abort();

  await assert.rejects(task, /aborted/u);
  await waitForProcessExit(childPid);
});

test('times out and reaps the complete producer process tree before rejecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidPath = join(root, 'child.pid');
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const producer = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const task = runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    timeoutMs: 100,
    maxObservedBytes: 1024 * 1024,
    maxObservedEntries: 100,
  });
  const childPid = Number.parseInt(await waitForFile(childPidPath), 10);

  await assert.rejects(task, /timed out/u);
  await waitForProcessExit(childPid);
});

test('enforces observed filesystem limits and reaps the producer tree before rejecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const childPidPath = join(root, 'child.pid');
  const oversizedPath = join(root, 'oversized.bin');
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const producer = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', process.stdout, process.stderr] });`,
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    `writeFileSync(${JSON.stringify(oversizedPath)}, Buffer.alloc(4096));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const task = runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    timeoutMs: 500,
    maxObservedBytes: 1024,
    maxObservedEntries: 100,
  });
  const childPid = Number.parseInt(await waitForFile(childPidPath), 10);

  await assert.rejects(
    task,
    (error: unknown) =>
      error instanceof Error &&
      (error as { readonly reason?: unknown }).reason === 'filesystem_limit_exceeded',
  );
  await waitForProcessExit(childPid);
});

test('accepts and accounts for a contained npm bin symlink on POSIX', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-bin-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const producer = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const bin = path.join(process.cwd(), 'node_modules', 'package', 'bin');",
    "const links = path.join(process.cwd(), 'node_modules', '.bin');",
    'fs.mkdirSync(bin, { recursive: true });',
    'fs.mkdirSync(links, { recursive: true });',
    "fs.writeFileSync(path.join(bin, 'cli.js'), 'module.exports = 1;\\n');",
    "fs.symlinkSync('../package/bin/cli.js', path.join(links, 'fixture-cli'));",
  ].join('');

  const result = await runManagedDependencyProducerProcessInternal({
    argv: [process.execPath, '-e', producer],
    cwd: root,
    env: process.env,
    monitorRoot: root,
    timeoutMs: 5_000,
    maxObservedBytes: 1024,
    maxObservedEntries: 10,
  });

  assert.equal(result.exitCode, 0);
});

test('rejects an escaping producer symlink as invalid output instead of a quota failure', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-escape-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const producer = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.symlinkSync('../../outside', path.join(process.cwd(), 'escape'));",
    'setInterval(() => {}, 1000);',
  ].join('');

  await assert.rejects(
    runManagedDependencyProducerProcessInternal({
      argv: [process.execPath, '-e', producer],
      cwd: root,
      env: process.env,
      monitorRoot: root,
      timeoutMs: 1_000,
      maxObservedBytes: 1024,
      maxObservedEntries: 10,
    }),
    /escaping symbolic link/u,
  );
});

test('counts empty files toward the producer entry quota', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-entry-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const producer = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const files = path.join(process.cwd(), 'many-empty-files');",
    'fs.mkdirSync(files);',
    "for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(files, String(index)), '');",
  ].join('');

  await assert.rejects(
    runManagedDependencyProducerProcessInternal({
      argv: [process.execPath, '-e', producer],
      cwd: root,
      env: process.env,
      monitorRoot: root,
      timeoutMs: 5_000,
      maxObservedBytes: 1024,
      maxObservedEntries: 10,
    }),
    /observed filesystem limit/u,
  );
});

test('rejects a non-zero producer exit with its bounded diagnostic tail', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-dependency-producer-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    runManagedDependencyProducerProcessInternal({
      argv: [process.execPath, '-e', "process.stderr.write('fixture failed\\n'); process.exit(7)"],
      cwd: root,
      env: process.env,
      monitorRoot: root,
      timeoutMs: 5_000,
      maxObservedBytes: 1024,
      maxObservedEntries: 10,
    }),
    /exit code 7: fixture failed/u,
  );
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function attestFixtureRuntime(root: string, fixtureCliPath: string) {
  const resourcesRoot = join(root, 'runtime-resources');
  const npmRoot = join(resourcesRoot, 'npm');
  const npmCliPath = join(npmRoot, 'bin', 'npm-cli.js');
  const packageJson = '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n';
  const license = 'Artistic License fixture\n';
  const cli = await readFile(fixtureCliPath);
  await mkdir(join(npmRoot, 'bin'), { recursive: true });
  await Promise.all([
    writeFile(join(npmRoot, 'package.json'), packageJson),
    writeFile(join(npmRoot, 'LICENSE'), license),
    writeFile(npmCliPath, cli),
  ]);
  const files = [
    manifestFile('LICENSE', Buffer.from(license)),
    manifestFile('bin/npm-cli.js', cli),
    manifestFile('package.json', Buffer.from(packageJson)),
  ];
  await writeFile(
    join(resourcesRoot, 'bundled-npm.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_npm_runtime_v1',
      provider: 'desktop/npm-cli',
      npmVersion: '12.0.2',
      platform: process.platform,
      arch: process.arch,
      runtimeRootRelativePath: 'npm',
      cliRelativePath: 'npm/bin/npm-cli.js',
      securityPatches: approvedSecurityPatches,
      files,
      distributionReady: true,
    })}\n`,
  );
  return await resolveBundledNpmRuntime({ resourcesRoot });
}

const approvedSecurityPatches = [
  {
    packageName: 'tar',
    fromVersion: '7.5.19',
    toVersion: '7.5.22',
    advisories: ['GHSA-r292-9mhp-454m'],
  },
  {
    packageName: 'brace-expansion',
    fromVersion: '5.0.7',
    toVersion: '5.0.9',
    advisories: ['GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895'],
  },
  {
    packageName: 'ip-address',
    fromVersion: '10.2.0',
    toVersion: '10.4.0',
    advisories: ['GHSA-mwp4-54f8-5fhr', 'GHSA-4xrf-jv44-h6hh', 'GHSA-22jq-vg5j-6vgg'],
  },
  {
    packageName: 'undici',
    fromVersion: '6.27.0',
    toVersion: '6.28.0',
    advisories: ['GHSA-8xcm-r25x-g524', 'GHSA-m8rv-5g2x-5cg5', 'GHSA-v3r7-h72x-cjcm'],
  },
] as const;

function manifestFile(path: string, bytes: Buffer) {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Producer descendant ${pid} survived cancellation`);
}

function fixtureProducerInput(outputRoot: string, scratchRoot: string) {
  return {
    identity: {
      protocolVersion: 1 as const,
      environmentId: `sha256:${'1'.repeat(64)}` as const,
      manifestPath: 'package.json',
      manifestSha256: `sha256:${'2'.repeat(64)}` as const,
      lockfilePath: 'package-lock.json',
      lockfileSha256: `sha256:${'3'.repeat(64)}` as const,
      packageManagerName: 'npm' as const,
      packageManagerVersion: '12.0.2',
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      producerRuntimeIdentitySha256: `sha256:${'4'.repeat(64)}` as const,
      producerPolicyIdentitySha256: `sha256:${'5'.repeat(64)}` as const,
      policyVersion: 'managed_dependency_environment_v1' as const,
    },
    outputRoot,
    scratchRoot,
    manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
    lockfileBytes: Buffer.from(
      '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture"}}}\n',
    ),
  };
}
