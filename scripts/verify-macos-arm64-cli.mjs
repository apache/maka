import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  assertMacosArm64CliHost,
  resolveMacosArm64CliArtifactPaths,
} from './package-macos-arm64-cli.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

  await new Promise((resolve, reject) => {
    let output = '';
    let ready = false;
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
      if (!ready && /Maka/i.test(output)) {
        ready = true;
        child.write('\u0003');
        closeTimer = setTimeout(() => child.write('\u0003'), 250);
      }
    });
    child.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      clearTimeout(closeTimer);
      if (!ready) {
        reject(
          new Error(
            `TUI exited before rendering in a PTY (exit ${exitCode}, signal ${signal}). Output: ${output.slice(-1000)}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export async function verifyMacosArm64Cli(
  archivePath,
  {
    platform = process.platform,
    arch = process.arch,
    run = runCommand,
    smokeTui = smokeTuiInPty,
  } = {},
) {
  assertMacosArm64CliHost(platform, arch);
  const desktopManifest = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
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

  const extractionRoot = await mkdtemp(join(dirname(resolvedArchivePath), '.verify-cli-'));
  try {
    await run('tar', ['-xzf', resolvedArchivePath, '-C', extractionRoot]);
    const archiveRoot = join(extractionRoot, expectedPaths.archiveRootName);
    const nodePath = join(archiveRoot, 'libexec', 'node', 'bin', 'node');
    const makaPath = join(archiveRoot, 'bin', 'maka');
    const makaAgentPath = join(archiveRoot, 'bin', 'maka-agent');
    const requiredPaths = [
      nodePath,
      makaPath,
      makaAgentPath,
      join(archiveRoot, 'LICENSE'),
      join(archiveRoot, 'NOTICE'),
      join(archiveRoot, 'libexec', 'node', 'LICENSE'),
      join(
        archiveRoot,
        'libexec',
        'node_modules',
        'node-pty',
        'prebuilds',
        'darwin-arm64',
        'pty.node',
      ),
      join(
        archiveRoot,
        'libexec',
        'node_modules',
        'fs-native-extensions',
        'prebuilds',
        'darwin-arm64',
        'fs-native-extensions.node',
      ),
      join(
        archiveRoot,
        'libexec',
        'node_modules',
        '@earendil-works',
        'pi-tui',
        'native',
        'darwin',
        'prebuilds',
        'darwin-arm64',
        'darwin-modifiers.node',
      ),
    ];
    await Promise.all(requiredPaths.map((path) => access(path)));

    for (const binaryPath of [
      nodePath,
      ...requiredPaths.filter((path) => path.endsWith('.node')),
    ]) {
      const { stdout } = await run('lipo', ['-archs', binaryPath]);
      if (!stdout.trim().split(/\s+/).includes('arm64')) {
        throw new Error(`${binaryPath} is not an arm64 binary.`);
      }
    }
    await run('codesign', ['--verify', '--strict', '--verbose=2', nodePath]);

    const isolatedHome = join(extractionRoot, 'home');
    const commandWorkspace = join(extractionRoot, 'workspace');
    await Promise.all([mkdir(isolatedHome), mkdir(commandWorkspace)]);
    const environment = {
      ...process.env,
      HOME: isolatedHome,
      MAKA_DISABLE_DEFERRED_TOOLS: '1',
    };

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
    if (!helpResult.stdout.includes('Usage: maka')) {
      throw new Error('CLI help did not render the Maka command surface.');
    }

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

    return { archivePath: resolvedArchivePath, checksumPath, sha256, version };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyMacosArm64Cli(process.argv[2]);
  console.log(`Verified ${result.archivePath}`);
  console.log(`SHA-256 ${result.sha256}`);
}
