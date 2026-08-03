import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertMacosArm64CliHost,
  assertNoDanglingSymlinks,
  listDependencyPatchNames,
  releaseToolchainFromManifest,
  resolveCliWorkspacePackages,
  resolveMacosArm64CliArtifactPaths,
} from './package-macos-arm64-cli.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tuiReadyPattern = /陪你把事做完|配置模型提供商/;

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

export function isTuiReadyOutput(output) {
  return tuiReadyPattern.test(output);
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
  const workspaceRoot = join(
    environment.HOME,
    'Library',
    'Application Support',
    'Maka',
    'workspaces',
    'default',
  );
  await mkdir(workspaceRoot, { recursive: true });
  const storageEntry = requireFromCli.resolve('@maka/storage');
  const { createConnectionStore } = await import(pathToFileURL(storageEntry).href);
  await createConnectionStore(workspaceRoot).create({
    slug: 'release-smoke-local',
    name: 'Release smoke local',
    providerType: 'ollama',
    defaultModel: 'release-smoke-model',
  });

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
      /\.(?:test|spec)\.(?:[cm]?js|d\.ts|[cm]?js\.map)$/.test(path)
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
      import('node:fs/promises').then(({ realpath }) => realpath(linkPath)),
      import('node:fs/promises').then(({ realpath }) => realpath(packagePath)),
    ]);
    if (resolvedLink !== resolvedPackage) {
      throw new Error(`${name} does not resolve to the packaged workspace directory.`);
    }
  }
  await assertNoDanglingSymlinks(join(archiveRoot, 'libexec'));
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

async function smokePatchedStreamingToolCalls(archiveRoot) {
  const cliManifestPath = join(
    archiveRoot,
    'libexec',
    'node_modules',
    'maka-agent',
    'package.json',
  );
  const requireFromCli = createRequire(cliManifestPath);
  const runtimeEntry = requireFromCli.resolve('@maka/runtime');
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

async function verifyBinarySignatures(binaryPaths, { requireReleaseSigning, run }) {
  let expectedTeamIdentifier;
  for (const binaryPath of binaryPaths) {
    await run('codesign', ['--verify', '--strict', '--verbose=2', binaryPath]);
    if (!requireReleaseSigning) continue;
    const signature = await run('codesign', ['-d', '--verbose=4', binaryPath]);
    const details = parseSignatureDetails(`${signature.stdout}\n${signature.stderr}`);
    if (!details.authority || !details.hardenedRuntime || !details.teamIdentifier) {
      throw new Error(`${binaryPath} is not signed with a hardened Developer ID identity.`);
    }
    expectedTeamIdentifier ??= details.teamIdentifier;
    if (details.teamIdentifier !== expectedTeamIdentifier) {
      throw new Error(`${binaryPath} is signed by a different Developer ID team.`);
    }
  }
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
  const [rootManifest, desktopManifest] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const toolchain = releaseToolchainFromManifest(rootManifest);
  const version = desktopManifest.version;
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

  const archiveEntries = await run('unzip', ['-Z1', resolvedArchivePath]);
  assertSafeCliArchiveEntries(
    archiveEntries.stdout.split('\n').filter(Boolean),
    expectedPaths.archiveRootName,
  );

  const extractionRoot = await mkdtemp(join(dirname(resolvedArchivePath), '.verify-cli-'));
  try {
    await run('ditto', ['-x', '-k', resolvedArchivePath, extractionRoot]);
    const archiveRoot = join(extractionRoot, expectedPaths.archiveRootName);
    const nodePath = join(archiveRoot, 'libexec', 'node', 'bin', 'node');
    const makaPath = join(archiveRoot, 'bin', 'maka');
    const makaAgentPath = join(archiveRoot, 'bin', 'maka-agent');
    const metadataPath = join(archiveRoot, 'RELEASE.json');
    const requiredPaths = [
      nodePath,
      makaPath,
      makaAgentPath,
      metadataPath,
      join(archiveRoot, 'LICENSE'),
      join(archiveRoot, 'NOTICE'),
      join(archiveRoot, 'libexec', 'node', 'LICENSE'),
    ];
    await Promise.all(requiredPaths.map((path) => access(path)));

    const [metadata, expectedDependencyPatches] = await Promise.all([
      readFile(metadataPath, 'utf8').then(JSON.parse),
      listDependencyPatchNames(),
    ]);
    if (
      metadata.version !== version ||
      metadata.nodeVersion !== toolchain.nodeVersion ||
      metadata.npmVersion !== toolchain.npmVersion
    ) {
      throw new Error('CLI release metadata does not match the pinned release toolchain.');
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
    ]);

    const nativeBinaries = await findFiles(
      join(archiveRoot, 'libexec', 'node_modules'),
      (path) => path.endsWith('.node') || basename(path) === 'spawn-helper',
    );
    if (nativeBinaries.length === 0) throw new Error('CLI artifact contains no native binaries.');
    for (const binaryPath of [nodePath, ...nativeBinaries]) {
      const { stdout } = await run('lipo', ['-archs', binaryPath]);
      const architectures = stdout.trim().split(/\s+/).filter(Boolean);
      if (architectures.length !== 1 || architectures[0] !== 'arm64') {
        throw new Error(`${binaryPath} must contain only arm64.`);
      }
    }
    const nodeDependencies = await run('otool', ['-L', nodePath]);
    assertSelfContainedNode(nodeDependencies.stdout);
    await verifyBinarySignatures([nodePath, ...nativeBinaries], { requireReleaseSigning, run });

    if (requireReleaseSigning) {
      await run('xattr', [
        '-w',
        '-r',
        'com.apple.quarantine',
        '0083;00000000;GitHub;MakaReleaseVerification',
        archiveRoot,
      ]);
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
    if (embeddedNodeVersion.stdout.trim() !== toolchain.nodeVersion) {
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
    const aliasVersionResult = await run(makaAgentPath, ['--version'], {
      cwd: commandWorkspace,
      env: environment,
    });
    if (aliasVersionResult.stdout.trim() !== version) {
      throw new Error('maka-agent alias reports a different version.');
    }
    const helpResult = await run(makaPath, ['--help'], {
      cwd: commandWorkspace,
      env: environment,
    });
    for (const command of ['run', 'eval', 'inspect']) {
      if (!helpResult.stdout.includes(command)) {
        throw new Error(`CLI help does not list ${command}.`);
      }
    }
    await smokePatchedStreamingToolCalls(archiveRoot);

    const fixtureDirectory = join(extractionRoot, 'eval-fixture');
    const outputDirectory = join(extractionRoot, 'eval-output');
    const specPath = join(extractionRoot, 'eval-spec.json');
    await mkdir(fixtureDirectory);
    await writeFile(join(fixtureDirectory, 'marker.txt'), 'ok\n', 'utf8');
    await writeFile(
      specPath,
      JSON.stringify({
        configs: [
          { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
        ],
        tasks: [
          {
            id: 'portable-cli-smoke',
            instruction: 'verify the portable CLI',
            workspaceDir: fixtureDirectory,
            verification: { command: 'test -f marker.txt', protectedPaths: [] },
          },
        ],
      }),
      'utf8',
    );
    const evalResult = await run(makaPath, ['eval', 'run', specPath, '--out', outputDirectory], {
      cwd: commandWorkspace,
      env: environment,
      timeout: 60_000,
    });
    if (!evalResult.stdout.includes('portable-cli-smoke')) {
      throw new Error('Deterministic non-interactive evaluation did not complete.');
    }
    await access(join(outputDirectory, 'comparison.md'));
    await smokeTui(archiveRoot, environment);

    return {
      archivePath: resolvedArchivePath,
      checksumPath,
      nativeBinaryCount: nativeBinaries.length,
      sha256,
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
