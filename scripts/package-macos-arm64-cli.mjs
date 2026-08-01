import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(repoRoot, 'apps', 'desktop', 'release');
const localPackageDirectories = [
  join(repoRoot, 'packages', 'cli'),
  join(repoRoot, 'packages', 'core'),
  join(repoRoot, 'packages', 'storage'),
  join(repoRoot, 'packages', 'runtime'),
  join(repoRoot, 'packages', 'headless'),
];

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

export function assertMacosArm64CliHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('CLI release packaging requires an Apple Silicon macOS host.');
  }
}

export function resolveMacosArm64CliArtifactPaths(version) {
  const archiveName = `Maka-${version}-cli-mac-arm64.tar.gz`;
  return {
    archiveRootName: `Maka-${version}-cli-mac-arm64`,
    archivePath: join(releaseDirectory, archiveName),
    checksumPath: join(releaseDirectory, `${archiveName}.sha256`),
  };
}

export function macosArm64CliWrapper() {
  return `#!/bin/sh
set -eu
bin_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$bin_dir/../libexec/node/bin/node" "$bin_dir/../libexec/node_modules/maka-agent/dist/cli.js" "$@"
`;
}

export function macosArm64CliInstallArgs(installRoot) {
  return [
    'ci',
    '--prefix',
    installRoot,
    '--omit=dev',
    '--workspace',
    'maka-agent',
    '--include-workspace-root=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function stageWorkspacePackages(installRoot) {
  await Promise.all([
    copyFile(join(repoRoot, 'package.json'), join(installRoot, 'package.json')),
    copyFile(join(repoRoot, 'package-lock.json'), join(installRoot, 'package-lock.json')),
    ...localPackageDirectories.map(async (sourceDirectory) => {
      const targetDirectory = join(installRoot, 'packages', basename(sourceDirectory));
      await mkdir(targetDirectory, { recursive: true });
      await Promise.all([
        copyFile(join(sourceDirectory, 'package.json'), join(targetDirectory, 'package.json')),
        cp(join(sourceDirectory, 'dist'), join(targetDirectory, 'dist'), { recursive: true }),
      ]);
    }),
  ]);
}

async function retainOnlyDirectory(parent, retainedName) {
  for (const entry of await readdir(parent)) {
    if (entry !== retainedName) {
      await rm(join(parent, entry), { recursive: true, force: true });
    }
  }
}

async function pruneNonTargetNativeBinaries(nodeModulesDirectory) {
  await retainOnlyDirectory(join(nodeModulesDirectory, 'node-pty', 'prebuilds'), 'darwin-arm64');
  await retainOnlyDirectory(
    join(nodeModulesDirectory, 'fs-native-extensions', 'prebuilds'),
    'darwin-arm64',
  );
  await retainOnlyDirectory(
    join(nodeModulesDirectory, '@earendil-works', 'pi-tui', 'native', 'darwin', 'prebuilds'),
    'darwin-arm64',
  );
  await rm(join(nodeModulesDirectory, '@earendil-works', 'pi-tui', 'native', 'win32'), {
    recursive: true,
    force: true,
  });
}

async function rewriteCliVersion(installRoot, version) {
  const manifestPath = join(installRoot, 'packages', 'cli', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function packageMacosArm64Cli({
  platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  env = process.env,
  run = runCommand,
} = {}) {
  assertMacosArm64CliHost(platform, arch);

  const desktopManifest = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  if (typeof desktopManifest.version !== 'string' || !desktopManifest.version.trim()) {
    throw new Error('Desktop release version is missing.');
  }

  const version = desktopManifest.version;
  const nodeRoot = dirname(dirname(execPath));
  const nodeLicensePath = join(nodeRoot, 'LICENSE');
  await Promise.all([
    access(execPath),
    access(nodeLicensePath),
    access(join(repoRoot, 'LICENSE')),
    access(join(repoRoot, 'NOTICE')),
    ...localPackageDirectories.map((path) => access(join(path, 'dist'))),
  ]);

  const { archiveRootName, archivePath, checksumPath } = resolveMacosArm64CliArtifactPaths(version);
  await mkdir(releaseDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(join(releaseDirectory, '.maka-cli-'));
  let complete = false;

  try {
    const installRoot = join(stagingRoot, 'install');
    await mkdir(installRoot, { recursive: true });
    await stageWorkspacePackages(installRoot);
    await run('npm', macosArm64CliInstallArgs(installRoot), { env });

    const nodeModulesDirectory = join(installRoot, 'node_modules');
    await rewriteCliVersion(installRoot, version);
    await pruneNonTargetNativeBinaries(nodeModulesDirectory);

    const archiveRoot = join(stagingRoot, archiveRootName);
    const binDirectory = join(archiveRoot, 'bin');
    const embeddedNodeDirectory = join(archiveRoot, 'libexec', 'node');
    await Promise.all([
      mkdir(binDirectory, { recursive: true }),
      mkdir(join(embeddedNodeDirectory, 'bin'), { recursive: true }),
    ]);
    await rename(nodeModulesDirectory, join(archiveRoot, 'libexec', 'node_modules'));
    await rename(join(installRoot, 'packages'), join(archiveRoot, 'libexec', 'packages'));
    await Promise.all([
      copyFile(execPath, join(embeddedNodeDirectory, 'bin', 'node')),
      copyFile(nodeLicensePath, join(embeddedNodeDirectory, 'LICENSE')),
      copyFile(join(repoRoot, 'LICENSE'), join(archiveRoot, 'LICENSE')),
      copyFile(join(repoRoot, 'NOTICE'), join(archiveRoot, 'NOTICE')),
      writeFile(join(binDirectory, 'maka'), macosArm64CliWrapper(), 'utf8'),
      writeFile(join(binDirectory, 'maka-agent'), macosArm64CliWrapper(), 'utf8'),
      writeFile(
        join(archiveRoot, 'README.txt'),
        [
          `Maka CLI/TUI ${version} for Apple Silicon macOS`,
          '',
          "Add this directory's bin folder to PATH, then run:",
          '  maka --help',
          '',
          'The archive includes its own Node.js runtime and does not require the Maka desktop app.',
          '',
        ].join('\n'),
        'utf8',
      ),
    ]);
    await Promise.all([
      chmod(join(embeddedNodeDirectory, 'bin', 'node'), 0o755),
      chmod(join(binDirectory, 'maka'), 0o755),
      chmod(join(binDirectory, 'maka-agent'), 0o755),
    ]);

    await Promise.all([rm(archivePath, { force: true }), rm(checksumPath, { force: true })]);
    await run('tar', ['-czf', archivePath, '-C', stagingRoot, archiveRootName], {
      env: { ...env, COPYFILE_DISABLE: '1' },
    });
    const sha256 = await sha256File(archivePath);
    await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`, 'utf8');
    complete = true;
    return { archivePath, checksumPath, sha256, version };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    if (!complete) {
      const { archivePath, checksumPath } = resolveMacosArm64CliArtifactPaths(version);
      await Promise.all([rm(archivePath, { force: true }), rm(checksumPath, { force: true })]);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await packageMacosArm64Cli();
  console.log(`Created ${result.archivePath}`);
  console.log(`SHA-256 ${result.sha256}`);
}
