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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import {
  assertMacosArm64CliHost,
  assertNoDanglingSymlinks,
  DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS,
  extractDistributionNodeEntitlements,
  inspectNativeArtifacts,
  isMacosArm64MachO,
  listApplicableDependencyPatchNames,
  OFFICIAL_NODE_RUNTIME_ENTITLEMENTS,
  resolveCliWorkspacePackages,
  resolveMacosArm64CliArtifactPaths,
} from './package-macos-arm64-cli.mjs';
import { resolveProductReleaseIdentity } from './product-release-identity.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tuiReadyPattern = /Maka\s*·\s*Auto\s*·/u;

async function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function dependencyKeysFromNotice(notice) {
  return [...notice.matchAll(/^Package: (.+)$/gm)].map((match) => match[1]).sort();
}

export function assertCliThirdPartyNotices(notice, metadata, actualSha256) {
  if (actualSha256 !== metadata.thirdPartyNoticesSha256) {
    throw new Error('CLI third-party notice digest does not match RELEASE.json.');
  }
  const noticeDependencies = dependencyKeysFromNotice(notice);
  if (JSON.stringify(noticeDependencies) !== JSON.stringify(metadata.productionDependencies)) {
    throw new Error('CLI third-party notices do not match the packaged production closure.');
  }
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`CLI artifact contains forbidden path: ${path}`);
}

export function isTuiReadyOutput(output) {
  return tuiReadyPattern.test(stripVTControlCharacters(output));
}

export function assertExpectedTuiExit({ ready, stopRequested, exitCode, signal, output }) {
  if (!ready) {
    throw new Error(
      `TUI exited before rendering in a PTY (exit ${exitCode}, signal ${signal}). Output: ${output.slice(-1000)}`,
    );
  }
  if (!stopRequested || (exitCode !== 0 && exitCode !== 130)) {
    throw new Error(
      `TUI crashed after startup (exit ${exitCode}, signal ${signal}). Output: ${output.slice(-1000)}`,
    );
  }
}

export function assertSafeCliArchiveEntries(entries, archiveRootName) {
  if (entries.length === 0) throw new Error('CLI archive is empty.');
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (
      normalized.startsWith('/') ||
      segments.includes('..') ||
      segments.some((segment) => segment.startsWith('._')) ||
      segments[0] !== archiveRootName
    ) {
      throw new Error(`Unsafe CLI archive entry: ${entry}`);
    }
  }
}

async function smokeTuiInPty(archiveRoot, environment) {
  const cliManifestPath = join(
    archiveRoot,
    'libexec',
    'node_modules',
    'maka-agent',
    'package.json',
  );
  const requireFromCli = createRequire(cliManifestPath);
  const pty = requireFromCli('node-pty');
  const executable = join(archiveRoot, 'bin', 'maka');
  await new Promise((resolvePromise, reject) => {
    let output = '';
    let ready = false;
    let stopRequested = false;
    let closeTimer;
    const child = pty.spawn(executable, [], {
      cols: 100,
      rows: 30,
      cwd: archiveRoot,
      env: { ...environment, TERM: 'xterm-256color' },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`TUI did not start in a PTY. Output: ${output.slice(-1000)}`));
    }, 10_000);

    child.onData((data) => {
      output += data;
      if (!ready && isTuiReadyOutput(output)) {
        ready = true;
        stopRequested = true;
        child.write('\u0003');
        closeTimer = setTimeout(() => child.write('\u0003'), 250);
      }
    });
    child.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      try {
        assertExpectedTuiExit({ ready, stopRequested, exitCode, signal, output });
        resolvePromise();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseLinkedLibraries(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function assertSelfContainedNode(output) {
  const nonSystemLibraries = parseLinkedLibraries(output).filter(
    (path) => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'),
  );
  if (nonSystemLibraries.length > 0) {
    throw new Error(`Embedded Node links non-system libraries: ${nonSystemLibraries.join(', ')}`);
  }
}

function parseSignatureDetails(output) {
  const authority = output.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const hardenedRuntime = output.includes('flags=0x10000(runtime)');
  return { authority, hardenedRuntime, teamIdentifier };
}

async function findFiles(directory, predicate) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await findFiles(path, predicate)));
    else if (entry.isFile() && predicate(path)) matches.push(path);
  }
  return matches;
}

async function assertNoTestArtifacts(archiveRoot) {
  const libexecRoot = join(archiveRoot, 'libexec');
  const forbidden = await findFiles(libexecRoot, (path) => {
    const pathFromLibexec = relative(libexecRoot, path);
    return (
      pathFromLibexec.split(sep).includes('__tests__') ||
      /\.(?:test|spec)\.(?:[cm]?js|d\.ts|[cm]?js\.map)$/.test(path) ||
      /^test_.*\.py$/u.test(basename(path))
    );
  });
  if (forbidden.length > 0) {
    throw new Error(`CLI artifact contains test files: ${forbidden.slice(0, 5).join(', ')}`);
  }
}

async function assertWorkspaceClosure(archiveRoot, metadata) {
  const workspacePackages = await resolveCliWorkspacePackages();
  const expectedNames = workspacePackages.map(({ name }) => name).sort();
  if (JSON.stringify(metadata.workspacePackages) !== JSON.stringify(expectedNames)) {
    throw new Error('CLI artifact workspace closure does not match package manifests.');
  }
  for (const { name, workspacePath } of workspacePackages) {
    const linkPath = join(archiveRoot, 'libexec', 'node_modules', ...name.split('/'));
    const packagePath = join(archiveRoot, 'libexec', workspacePath);
    const [resolvedLink, resolvedPackage] = await Promise.all([
      realpath(linkPath),
      realpath(packagePath),
    ]);
    if (resolvedLink !== resolvedPackage) {
      throw new Error(`${name} does not resolve to the packaged workspace directory.`);
    }
  }
  await assertNoDanglingSymlinks(join(archiveRoot, 'libexec'));
}

async function smokePackagedEval(archiveRoot, sourceCommit, environment, run) {
  // Exercise the staged runner and relay offline against the narrow Harbor API
  // they consume, so release verification stays deterministic and provider-free.
  const smokeRoot = await mkdtemp(join(environment.TMPDIR, 'eval-smoke-'));
  try {
    const python = await run(
      'python3',
      [
        '-c',
        'import json, sys; print(json.dumps({"executable": sys.executable, "version": list(sys.version_info[:3])}))',
      ],
      { env: process.env },
    );
    const pythonIdentity = JSON.parse(python.stdout);
    if (
      !isAbsolute(pythonIdentity.executable) ||
      !Array.isArray(pythonIdentity.version) ||
      pythonIdentity.version[0] !== 3 ||
      pythonIdentity.version[1] < 10
    ) {
      throw new Error('Packaged eval smoke requires Python 3.10 or newer.');
    }

    const fixtureRoot = join(smokeRoot, 'python');
    const trialsRoot = join(smokeRoot, 'trials');
    const taskCache = join(smokeRoot, 'task-cache');
    const markerPath = join(smokeRoot, 'marker.json');
    const specPath = join(smokeRoot, 'experiment.json');
    const outputPath = join(smokeRoot, 'output');
    await mkdir(fixtureRoot, { recursive: true });
    await copyFile(
      join(repoRoot, 'scripts', 'release-eval-smoke-sitecustomize.py'),
      join(fixtureRoot, 'sitecustomize.py'),
    );

    const spec = {
      schemaVersion: 'maka.eval.v1',
      id: 'release-artifact-smoke',
      benchmark: {
        id: 'release-smoke',
        version: sourceCommit,
        config: { repository: 'https://github.com/apache/maka.git' },
      },
      executor: {
        kind: 'harbor',
        config: {
          frameworkVersion: '0.20.0',
          pythonPathEnv: 'MAKA_CLI_EVAL_SMOKE_PYTHON',
          trialsRootEnv: 'MAKA_CLI_EVAL_SMOKE_TRIALS',
          environment: {},
          preparationEnvironment: [
            'PYTHONPATH',
            'MAKA_CLI_EVAL_SMOKE_CACHE',
            'MAKA_CLI_EVAL_SMOKE_MARKER',
          ],
          mounts: [],
          egressProxy: {
            composeSourceEnv: 'MAKA_EVAL_MAKA_BUNDLE_PATH',
            composeRelativePath: 'packages/eval/harbor/docker-compose-egress-proxy.yaml',
            networkPolicyRelativePath: 'packages/eval/harbor/egress-proxy/network-policy',
            proxyUrl: 'http://maka-eval-mitmproxy:8080',
            allowedHost: 'maka-eval-mitmproxy',
            containerCaPath: '/opt/maka-egress/mitmproxy-ca-cert.pem',
          },
        },
      },
      execution: { maxConcurrentTaskGroups: 1 },
      subjects: [
        {
          id: 'external',
          kind: 'external',
          credentials: [],
          config: { command: '/usr/bin/true', args: [], result: 'exit-code' },
        },
      ],
      tasks: [
        {
          id: 'smoke',
          input: 'release smoke',
          config: { harbor: { path: 'tasks/release-smoke' } },
        },
      ],
      repetitions: 1,
      budget: { timeoutMultiplier: 1 },
      verifier: { reward: 'reward' },
    };
    await writeFile(specPath, `${JSON.stringify(spec)}\n`, 'utf8');
    const smokeEnvironment = {
      ...environment,
      MAKA_CLI_EVAL_SMOKE_CACHE: taskCache,
      MAKA_CLI_EVAL_SMOKE_MARKER: markerPath,
      MAKA_CLI_EVAL_SMOKE_PYTHON: pythonIdentity.executable,
      MAKA_CLI_EVAL_SMOKE_TRIALS: trialsRoot,
      PYTHONPATH: fixtureRoot,
    };
    const makaPath = join(archiveRoot, 'bin', 'maka');
    const result = await run(makaPath, ['eval', 'run', specPath, '--out', outputPath], {
      cwd: smokeRoot,
      env: smokeEnvironment,
      timeout: 30_000,
    });
    const summary = JSON.parse(result.stdout);
    if (summary.experimentId !== spec.id || summary.cells !== 1 || summary.incomplete !== 0) {
      throw new Error('Packaged eval smoke did not complete its one deterministic cell.');
    }

    const cellId = 'smoke::1::external';
    const attemptPath = join(
      outputPath,
      'attempts',
      createHash('sha256').update(cellId).digest('hex'),
      '000001.json',
    );
    const attempt = JSON.parse(await readFile(attemptPath, 'utf8'));
    if (
      attempt.cellId !== cellId ||
      attempt.result?.status !== 'completed' ||
      attempt.result.score !== 1
    ) {
      throw new Error('Packaged eval smoke did not record a completed, verified attempt.');
    }

    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const expectedRunTrial = await realpath(
      join(archiveRoot, 'libexec', 'packages', 'eval', 'harbor', 'run_trial.py'),
    );
    const expectedRelayAgent = await realpath(
      join(archiveRoot, 'libexec', 'packages', 'eval', 'harbor', 'relay_agent.py'),
    );
    if (
      marker.runTrial !== expectedRunTrial ||
      marker.relayAgent !== expectedRelayAgent ||
      marker.relayName !== 'maka-eval-relay'
    ) {
      throw new Error('Packaged eval smoke did not execute the staged Harbor runtime assets.');
    }
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function streamingChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-release-smoke',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'release-smoke-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function assertPatchedStreamingToolCalls(parts) {
  const errors = parts.filter((part) => part.type === 'error');
  if (errors.length > 0 || parts.at(-1)?.type !== 'finish') {
    throw new Error('Packaged provider-utils failed to finish streamed tool calls.');
  }
  const actualCalls = parts
    .filter((part) => part.type === 'tool-call')
    .map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }));
  const expectedCalls = [
    { toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"a.txt"}' },
    { toolCallId: 'call_2', toolName: 'read_file', input: '{"path":"b.txt"}' },
  ];
  if (JSON.stringify(actualCalls) !== JSON.stringify(expectedCalls)) {
    throw new Error('Packaged provider-utils reordered or dropped streamed tool calls.');
  }
}

export function resolvePackagedRuntimeModelFactory(archiveRoot) {
  const cliManifestPath = join(
    archiveRoot,
    'libexec',
    'node_modules',
    'maka-agent',
    'package.json',
  );
  const requireFromCli = createRequire(cliManifestPath);
  return requireFromCli.resolve('@maka/runtime/model-factory');
}

async function smokePatchedStreamingToolCalls(archiveRoot) {
  const runtimeEntry = resolvePackagedRuntimeModelFactory(archiveRoot);
  const { getAIModel } = await import(pathToFileURL(runtimeEntry).href);
  const payloads = [
    streamingChunk({ role: 'assistant', content: 'Reading both files.' }),
    streamingChunk({
      tool_calls: [
        {
          index: 1,
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '' },
        },
      ],
    }),
    streamingChunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"a.txt"}' } }] }),
    streamingChunk({
      tool_calls: [
        {
          index: 2,
          id: 'call_2',
          type: 'function',
          function: { name: 'read_file', arguments: '' },
        },
      ],
    }),
    streamingChunk({ tool_calls: [{ index: 2, function: { arguments: '{"path":"b.txt"}' } }] }),
    streamingChunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  const model = getAIModel({
    connection: {
      slug: 'release-smoke',
      providerType: 'openai-compatible',
      baseUrl: 'https://release-smoke.invalid/v1',
      defaultModel: 'release-smoke-model',
    },
    apiKey: 'release-smoke-key',
    modelId: 'release-smoke-model',
    fetch: async () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream' }, status: 200 }),
  });
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt and b.txt' }] }],
    tools: [
      {
        type: 'function',
        name: 'read_file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  });
  const parts = [];
  for await (const part of stream) parts.push(part);
  assertPatchedStreamingToolCalls(parts);
}

async function verifyBinarySignatures(
  binaryPaths,
  { expectedTeamIdentifier, nodePath, requireReleaseSigning, run },
) {
  for (const binaryPath of binaryPaths) {
    await run('codesign', ['--verify', '--strict', '--verbose=2', binaryPath]);
    if (!requireReleaseSigning) continue;
    const signature = await run('codesign', ['-d', '--verbose=4', binaryPath]);
    const details = parseSignatureDetails(`${signature.stdout}\n${signature.stderr}`);
    if (!details.authority || !details.hardenedRuntime || !details.teamIdentifier) {
      throw new Error(`${binaryPath} is not signed with a hardened Developer ID identity.`);
    }
    if (details.teamIdentifier !== expectedTeamIdentifier) {
      throw new Error(
        `${binaryPath} is signed by Apple team ${details.teamIdentifier}, expected ${expectedTeamIdentifier}.`,
      );
    }
    if (resolve(binaryPath) === resolve(nodePath)) {
      const entitlements = await run('codesign', ['-d', '--entitlements', ':-', binaryPath]);
      extractDistributionNodeEntitlements(`${entitlements.stdout}\n${entitlements.stderr}`);
    }
  }
  return expectedTeamIdentifier;
}

export async function verifyQuarantinedExecution(archiveRoot, nodePath, run) {
  await run('xattr', [
    '-w',
    '-r',
    'com.apple.quarantine',
    '0083;00000000;GitHub;MakaReleaseVerification',
    archiveRoot,
  ]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', nodePath]);
}

export async function verifyMacosArm64Cli(
  archivePath,
  {
    platform = process.platform,
    arch = process.arch,
    run = runCommand,
    smokeTui = smokeTuiInPty,
    requireReleaseSigning = process.env.MAKA_CLI_REQUIRE_RELEASE_SIGNING === '1',
  } = {},
) {
  assertMacosArm64CliHost(platform, arch);
  const [rootManifest, desktopManifest, cliManifest, sourceCommitResult] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8').then(JSON.parse),
    run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
  ]);
  const identity = resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest,
    cliManifest,
    sha: sourceCommitResult.stdout.trim(),
  });
  const version = identity.version;
  const expectedPaths = resolveMacosArm64CliArtifactPaths(version);
  const resolvedArchivePath = resolve(archivePath ?? expectedPaths.archivePath);
  const checksumPath = `${resolvedArchivePath}.sha256`;
  await Promise.all([access(resolvedArchivePath), access(checksumPath)]);

  const sha256 = await sha256File(resolvedArchivePath);
  const expectedChecksum = `${sha256}  ${basename(resolvedArchivePath)}\n`;
  const actualChecksum = await readFile(checksumPath, 'utf8');
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`CLI checksum does not match ${basename(resolvedArchivePath)}.`);
  }

  const archiveEntries = await run('unzip', ['-Z1', resolvedArchivePath], {
    timeout: 120_000,
  });
  assertSafeCliArchiveEntries(
    archiveEntries.stdout.split('\n').filter(Boolean),
    expectedPaths.archiveRootName,
  );

  const extractionRoot = await mkdtemp(join(dirname(resolvedArchivePath), '.verify-cli-'));
  try {
    await run('ditto', ['-x', '-k', resolvedArchivePath, extractionRoot], {
      timeout: 300_000,
    });
    const archiveRoot = join(extractionRoot, expectedPaths.archiveRootName);
    const nodePath = join(archiveRoot, 'libexec', 'node', 'bin', 'node');
    const makaPath = join(archiveRoot, 'bin', 'maka');
    const metadataPath = join(archiveRoot, 'RELEASE.json');
    const thirdPartyNoticesPath = join(archiveRoot, 'THIRD_PARTY_NOTICES.txt');
    const requiredPaths = [
      nodePath,
      makaPath,
      metadataPath,
      thirdPartyNoticesPath,
      join(archiveRoot, 'DISCLAIMER-WIP'),
      join(archiveRoot, 'LICENSE'),
      join(archiveRoot, 'NOTICE'),
      join(archiveRoot, 'libexec', 'node', 'LICENSE'),
    ];
    await Promise.all([
      ...requiredPaths.map((path) => access(path)),
      assertMissing(join(archiveRoot, 'bin', 'maka-agent')),
    ]);

    const [metadata, expectedDependencyPatches, thirdPartyNotices] = await Promise.all([
      readFile(metadataPath, 'utf8').then(JSON.parse),
      listApplicableDependencyPatchNames(join(archiveRoot, 'libexec', 'node_modules')),
      readFile(thirdPartyNoticesPath, 'utf8'),
    ]);
    if (
      metadata.schemaVersion !== 1 ||
      metadata.product !== 'Maka' ||
      metadata.version !== version ||
      metadata.sourceCommit !== identity.sourceCommit ||
      metadata.platform !== 'macos' ||
      metadata.architecture !== 'arm64' ||
      metadata.node?.version !== identity.nodeVersion ||
      metadata.node?.sourceUrl !== identity.nodeSourceUrl ||
      metadata.node?.archive !== identity.nodeArchive ||
      metadata.node?.archiveSha256 !== identity.nodeArchiveSha256 ||
      JSON.stringify(metadata.node?.entitlements) !==
        JSON.stringify(
          requireReleaseSigning
            ? DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS
            : OFFICIAL_NODE_RUNTIME_ENTITLEMENTS,
        ) ||
      metadata.npmVersion !== identity.npmVersion ||
      (requireReleaseSigning && metadata.signingTeamIdentifier !== identity.appleTeamIdentifier) ||
      JSON.stringify(metadata.publicCommands) !== JSON.stringify(identity.publicCommands)
    ) {
      throw new Error('CLI release metadata does not match the product release identity.');
    }
    if (JSON.stringify(metadata.dependencyPatches) !== JSON.stringify(expectedDependencyPatches)) {
      throw new Error('CLI release metadata does not match the repository dependency patches.');
    }
    if (requireReleaseSigning && metadata.signing !== 'developer-id-notarized') {
      throw new Error('Release CLI artifact is not marked as Developer ID signed and notarized.');
    }
    await Promise.all([
      assertWorkspaceClosure(archiveRoot, metadata),
      assertNoTestArtifacts(archiveRoot),
      sha256File(thirdPartyNoticesPath).then((digest) =>
        assertCliThirdPartyNotices(thirdPartyNotices, metadata, digest),
      ),
    ]);

    const { foreignBinaries, machOBinaries } = await inspectNativeArtifacts(archiveRoot, {
      inspect: run,
    });
    if (foreignBinaries.length > 0) {
      throw new Error(
        `CLI artifact contains foreign native binaries: ${foreignBinaries.join(', ')}`,
      );
    }
    if (machOBinaries.length === 0) throw new Error('CLI artifact contains no Mach-O binaries.');
    const relativeMachOBinaries = machOBinaries.map((path) => relative(archiveRoot, path)).sort();
    if (JSON.stringify(relativeMachOBinaries) !== JSON.stringify(metadata.machOBinaries)) {
      throw new Error('CLI Mach-O inventory does not match RELEASE.json.');
    }
    for (const binaryPath of machOBinaries) {
      const [architectures, buildVersion] = await Promise.all([
        run('lipo', ['-archs', binaryPath]),
        run('xcrun', ['vtool', '-show-build', binaryPath]),
      ]);
      if (!isMacosArm64MachO(architectures.stdout, buildVersion.stdout)) {
        throw new Error(`${binaryPath} must target only Apple Silicon macOS.`);
      }
    }
    const nodeDependencies = await run('otool', ['-L', nodePath]);
    assertSelfContainedNode(nodeDependencies.stdout);
    const signingTeamIdentifier = await verifyBinarySignatures(machOBinaries, {
      expectedTeamIdentifier: identity.appleTeamIdentifier,
      nodePath,
      requireReleaseSigning,
      run,
    });

    if (requireReleaseSigning) {
      await verifyQuarantinedExecution(archiveRoot, nodePath, run);
    }

    const isolatedHome = join(extractionRoot, 'home');
    const commandWorkspace = join(extractionRoot, 'workspace');
    await Promise.all([mkdir(isolatedHome), mkdir(commandWorkspace)]);
    const environment = {
      HOME: isolatedHome,
      LANG: 'en_US.UTF-8',
      MAKA_DISABLE_DEFERRED_TOOLS: '1',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh',
      TMPDIR: extractionRoot,
    };

    const embeddedNodeVersion = await run(nodePath, ['-p', 'process.versions.node'], {
      cwd: commandWorkspace,
      env: environment,
    });
    if (embeddedNodeVersion.stdout.trim() !== identity.nodeVersion) {
      throw new Error('Embedded Node version does not match the pinned release toolchain.');
    }
    const versionResult = await run(makaPath, ['--version'], {
      cwd: commandWorkspace,
      env: environment,
    });
    if (versionResult.stdout.trim() !== version) {
      throw new Error(
        `CLI version ${versionResult.stdout.trim()} does not match desktop ${version}.`,
      );
    }
    const externalBin = join(extractionRoot, 'external-bin');
    const externalMakaPath = join(externalBin, 'maka');
    await mkdir(externalBin);
    await symlink(makaPath, externalMakaPath);
    const externalVersionResult = await run(externalMakaPath, ['--version'], {
      cwd: commandWorkspace,
      env: environment,
    });
    if (externalVersionResult.stdout.trim() !== version) {
      throw new Error('The maka launcher is not relocatable through an external symlink.');
    }
    const helpResult = await run(makaPath, ['--help'], {
      cwd: commandWorkspace,
      env: environment,
    });
    for (const command of ['run', 'eval']) {
      if (!helpResult.stdout.includes(command)) {
        throw new Error(`CLI help does not list ${command}.`);
      }
    }
    await smokePatchedStreamingToolCalls(archiveRoot);

    const profileListResult = await run(makaPath, ['runtime-host', 'profile', 'list'], {
      cwd: commandWorkspace,
      env: environment,
    });
    const profiles = JSON.parse(profileListResult.stdout);
    if (
      !Array.isArray(profiles) ||
      !profiles.some(
        (profile) =>
          profile?.id === 'local' && profile.name === 'Local' && profile.kind === 'local',
      )
    ) {
      throw new Error('Packaged non-interactive profile command did not return the local profile.');
    }
    const evalHelpResult = await run(makaPath, ['eval', '--help'], {
      cwd: commandWorkspace,
      env: environment,
    });
    if (!evalHelpResult.stdout.includes('maka eval run <spec.json>')) {
      throw new Error('Packaged eval command did not load its public CLI contract.');
    }
    await smokePackagedEval(archiveRoot, identity.sourceCommit, environment, run);
    await smokeTui(archiveRoot, environment);

    return {
      archivePath: resolvedArchivePath,
      checksumPath,
      machOBinaryCount: machOBinaries.length,
      sha256,
      signingTeamIdentifier,
      evalSmokeVerified: true,
      streamingPatchVerified: true,
      version,
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyMacosArm64Cli(process.argv[2]);
  console.log(`Verified ${result.archivePath}`);
  console.log(`SHA-256 ${result.sha256}`);
}
