import { execFile, spawn } from 'node:child_process';
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
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(repoRoot, 'apps', 'desktop', 'release');
const dependencyPatchesDirectory = join(repoRoot, 'patches');
const cliPackageName = 'maka-agent';
const localPackagePrefix = '@maka/';
const requiredSigningEnvironment = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
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

function inspectCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
}

export function assertMacosArm64CliHost(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('CLI release packaging requires an Apple Silicon macOS host.');
  }
}

export function resolveMacosArm64CliArtifactPaths(version) {
  const archiveName = `Maka-${version}-cli-mac-arm64.zip`;
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

export function macosArm64CliInstallArgs() {
  return [
    'ci',
    '--omit=dev',
    '--workspace',
    cliPackageName,
    '--include-workspace-root=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
}

export function releaseToolchainFromManifest(manifest) {
  const nodeVersion = manifest.releaseToolchain?.node;
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '');
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error('package.json must define an exact releaseToolchain.node version.');
  }
  if (!npmMatch) {
    throw new Error('package.json packageManager must pin an exact npm version.');
  }
  return { nodeVersion, npmVersion: npmMatch[1] };
}

function manifestFromEntry(entry) {
  return entry?.manifest ?? entry;
}

export function collectWorkspaceDependencyClosure(entryName, manifestsByName) {
  const closure = new Set();
  const visiting = new Set();

  function visit(packageName) {
    if (closure.has(packageName)) return;
    if (visiting.has(packageName)) {
      throw new Error(`Workspace dependency cycle reached ${packageName}.`);
    }
    const entry = manifestsByName.get(packageName);
    if (!entry) {
      throw new Error(`Workspace package ${packageName} is missing.`);
    }
    visiting.add(packageName);
    const manifest = manifestFromEntry(entry);
    for (const dependencyName of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (manifestsByName.has(dependencyName)) {
        visit(dependencyName);
      } else if (dependencyName.startsWith(localPackagePrefix)) {
        throw new Error(
          `${packageName} depends on local package ${dependencyName}, but it is not in workspaces.`,
        );
      }
    }
    visiting.delete(packageName);
    closure.add(packageName);
  }

  visit(entryName);
  return [...closure].sort();
}

function assertInsideRepo(path) {
  const pathFromRepo = relative(repoRoot, path);
  if (pathFromRepo === '..' || pathFromRepo.startsWith(`..${sep}`) || isAbsolute(pathFromRepo)) {
    throw new Error(`Workspace path escapes the repository: ${path}`);
  }
}

export async function resolveCliWorkspacePackages() {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const manifestsByName = new Map();
  for (const workspacePath of rootManifest.workspaces ?? []) {
    if (typeof workspacePath !== 'string' || /[*?[\]{}]/.test(workspacePath)) {
      throw new Error(`CLI release requires explicit workspace paths, found ${workspacePath}.`);
    }
    const directory = resolve(repoRoot, workspacePath);
    assertInsideRepo(directory);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name) {
      throw new Error(`${workspacePath}/package.json is missing a package name.`);
    }
    if (manifestsByName.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name ${manifest.name}.`);
    }
    manifestsByName.set(manifest.name, { directory, manifest, workspacePath });
  }

  return collectWorkspaceDependencyClosure(cliPackageName, manifestsByName).map((name) => ({
    name,
    ...manifestsByName.get(name),
  }));
}

function isTestArtifactName(name) {
  return /\.(?:test|spec)\.(?:[cm]?js|d\.ts|[cm]?js\.map)$/.test(name);
}

export async function pruneTestArtifacts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name === '__tests__') {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await pruneTestArtifacts(path);
    } else if (entry.isFile() && isTestArtifactName(entry.name)) {
      await rm(path, { force: true });
    }
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function stageWorkspacePackages(installRoot, workspacePackages) {
  await Promise.all([
    copyFile(join(repoRoot, 'package.json'), join(installRoot, 'package.json')),
    copyFile(join(repoRoot, 'package-lock.json'), join(installRoot, 'package-lock.json')),
    ...workspacePackages.map(async ({ directory, workspacePath }) => {
      const targetDirectory = join(installRoot, workspacePath);
      await mkdir(targetDirectory, { recursive: true });
      await Promise.all([
        copyFile(join(directory, 'package.json'), join(targetDirectory, 'package.json')),
        cp(join(directory, 'dist'), join(targetDirectory, 'dist'), { recursive: true }),
      ]);
      await pruneTestArtifacts(join(targetDirectory, 'dist'));
    }),
  ]);
}

export async function listDependencyPatchNames() {
  let entries;
  try {
    entries = await readdir(dependencyPatchesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
    .map((entry) => entry.name)
    .sort();
}

export async function applyDependencyPatches(
  installRoot,
  { env = process.env, run = runCommand, patchPackageEntry } = {},
) {
  const patchNames = await listDependencyPatchNames();
  if (patchNames.length === 0) return patchNames;

  const stagedPatchesDirectory = join(installRoot, 'patches');
  await mkdir(stagedPatchesDirectory, { recursive: true });
  await Promise.all(
    patchNames.map((name) =>
      copyFile(join(dependencyPatchesDirectory, name), join(stagedPatchesDirectory, name)),
    ),
  );

  const entry = patchPackageEntry ?? requireFromHere.resolve('patch-package/index.js');
  await run(process.execPath, [entry, '--error-on-fail'], { cwd: installRoot, env });
  return patchNames;
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

async function rewriteCliVersion(installRoot, workspacePackages, version) {
  const cliPackage = workspacePackages.find(({ name }) => name === cliPackageName);
  if (!cliPackage) throw new Error(`${cliPackageName} is missing from the workspace closure.`);
  const manifestPath = join(installRoot, cliPackage.workspacePath, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function packageModulePath(nodeModulesDirectory, packageName) {
  return join(nodeModulesDirectory, ...packageName.split('/'));
}

export async function assertNoDanglingSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        await realpath(path);
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`Dangling symlink in CLI artifact: ${path}`);
        throw error;
      }
    } else if (entry.isDirectory()) {
      await assertNoDanglingSymlinks(path);
    }
  }
}

async function assertWorkspaceLinks(archiveRoot, workspacePackages) {
  const nodeModulesDirectory = join(archiveRoot, 'libexec', 'node_modules');
  for (const { name, workspacePath } of workspacePackages) {
    const linkTarget = await realpath(packageModulePath(nodeModulesDirectory, name));
    const packageTarget = await realpath(join(archiveRoot, 'libexec', workspacePath));
    if (linkTarget !== packageTarget) {
      throw new Error(`${name} does not resolve to its staged workspace package.`);
    }
  }
  await assertNoDanglingSymlinks(join(archiveRoot, 'libexec'));
}

function parseLinkedLibraries(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export function assertOfficialNodeRuntime({
  actualVersion,
  expectedVersion,
  architectures,
  signature,
  linkedLibraries,
}) {
  if (actualVersion !== expectedVersion) {
    throw new Error(`CLI release requires Node ${expectedVersion}, found ${actualVersion}.`);
  }
  const architectureList = architectures.trim().split(/\s+/).filter(Boolean);
  if (architectureList.length !== 1 || architectureList[0] !== 'arm64') {
    throw new Error(
      `CLI Node runtime must contain only arm64, found ${architectureList.join(', ')}.`,
    );
  }
  if (!signature.includes('Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)')) {
    throw new Error('CLI release requires the official Node.js Foundation runtime.');
  }
  if (!signature.includes('flags=0x10000(runtime)')) {
    throw new Error('CLI Node runtime must use the hardened runtime signature.');
  }
  const nonSystemLibraries = linkedLibraries.filter(
    (path) => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'),
  );
  if (nonSystemLibraries.length > 0) {
    throw new Error(
      `CLI Node runtime is not self-contained; non-system libraries: ${nonSystemLibraries.join(', ')}`,
    );
  }
}

async function inspectReleaseToolchain({ execPath, env, inspect, toolchain }) {
  const [nodeVersion, npmVersion, architectures, signature, dependencies] = await Promise.all([
    inspect(execPath, ['-p', 'process.versions.node'], { env }),
    inspect('npm', ['--version'], { env }),
    inspect('lipo', ['-archs', execPath], { env }),
    inspect('codesign', ['-d', '--verbose=4', execPath], { env }),
    inspect('otool', ['-L', execPath], { env }),
  ]);
  assertOfficialNodeRuntime({
    actualVersion: nodeVersion.stdout.trim(),
    expectedVersion: toolchain.nodeVersion,
    architectures: architectures.stdout,
    signature: `${signature.stdout}\n${signature.stderr}`,
    linkedLibraries: parseLinkedLibraries(dependencies.stdout),
  });
  if (npmVersion.stdout.trim() !== toolchain.npmVersion) {
    throw new Error(
      `CLI release requires npm ${toolchain.npmVersion}, found ${npmVersion.stdout.trim()}.`,
    );
  }
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

function isCliNativeBinary(path) {
  return path.endsWith('.node') || basename(path) === 'spawn-helper';
}

export function assertReleaseSigningEnvironment(env) {
  for (const name of requiredSigningEnvironment) {
    if (!env[name]?.trim()) throw new Error(`CLI release signing requires ${name}.`);
  }
}

export function assertAcceptedNotarization(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('notarytool did not return valid JSON.');
  }
  if (result.status !== 'Accepted') {
    throw new Error(`CLI notarization failed with status ${result.status ?? 'unknown'}.`);
  }
}

async function signCliBinaries(archiveRoot, { env, run }) {
  assertReleaseSigningEnvironment(env);
  const { createKeychain, findIdentity, removeKeychain } = requireFromHere(
    'app-builder-lib/out/codeSign/macCodeSign',
  );
  const { TmpDir } = requireFromHere('temp-file');
  const temporaryFiles = new TmpDir('maka-cli-signing');
  let keychainFile;
  try {
    ({ keychainFile } = await createKeychain({
      tmpDir: temporaryFiles,
      cscLink: env.CSC_LINK,
      cscKeyPassword: env.CSC_KEY_PASSWORD,
      currentDir: repoRoot,
    }));
    const identity = await findIdentity('Developer ID Application', null, keychainFile);
    if (!identity) throw new Error('Could not resolve a Developer ID Application identity.');
    if (!identity.hash) throw new Error('Developer ID Application identity is missing its hash.');

    const nodePath = join(archiveRoot, 'libexec', 'node', 'bin', 'node');
    const nativeBinaries = await findFiles(
      join(archiveRoot, 'libexec', 'node_modules'),
      isCliNativeBinary,
    );
    if (nativeBinaries.length === 0) throw new Error('CLI artifact contains no native binaries.');
    for (const binaryPath of [...nativeBinaries, nodePath]) {
      await run(
        'codesign',
        [
          '--force',
          '--options',
          'runtime',
          '--timestamp',
          '--sign',
          identity.hash,
          '--keychain',
          keychainFile,
          binaryPath,
        ],
        { env },
      );
      await run('codesign', ['--verify', '--strict', '--verbose=2', binaryPath], { env });
    }
    return { identityName: identity.name, nativeBinaryCount: nativeBinaries.length };
  } finally {
    if (keychainFile) await removeKeychain(keychainFile, false);
    await temporaryFiles.cleanup();
  }
}

async function createCliZip(archiveRoot, archivePath, { env, run }) {
  await rm(archivePath, { force: true });
  await run(
    'ditto',
    [
      '-c',
      '-k',
      '--keepParent',
      '--norsrc',
      '--noextattr',
      '--noqtn',
      '--noacl',
      archiveRoot,
      archivePath,
    ],
    { env },
  );
}

async function notarizeCliZip(archivePath, { env, inspect }) {
  const result = await inspect(
    'xcrun',
    [
      'notarytool',
      'submit',
      archivePath,
      '--key',
      env.APPLE_API_KEY,
      '--key-id',
      env.APPLE_API_KEY_ID,
      '--issuer',
      env.APPLE_API_ISSUER,
      '--wait',
      '--output-format',
      'json',
    ],
    { env, timeout: 20 * 60_000 },
  );
  assertAcceptedNotarization(result.stdout);
}

export async function packageMacosArm64Cli({
  platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  env = process.env,
  run = runCommand,
  inspect = inspectCommand,
  releaseSigning = env.MAKA_CLI_RELEASE_SIGNING === '1',
} = {}) {
  assertMacosArm64CliHost(platform, arch);

  const [rootManifest, desktopManifest, workspacePackages] = await Promise.all([
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
    resolveCliWorkspacePackages(),
  ]);
  if (typeof desktopManifest.version !== 'string' || !desktopManifest.version.trim()) {
    throw new Error('Desktop release version is missing.');
  }
  const toolchain = releaseToolchainFromManifest(rootManifest);
  if (releaseSigning) assertReleaseSigningEnvironment(env);
  await inspectReleaseToolchain({ execPath, env, inspect, toolchain });

  const version = desktopManifest.version;
  const nodeRoot = dirname(dirname(execPath));
  const nodeLicensePath = join(nodeRoot, 'LICENSE');
  await Promise.all([
    access(execPath),
    access(nodeLicensePath),
    access(join(repoRoot, 'LICENSE')),
    access(join(repoRoot, 'NOTICE')),
    ...workspacePackages.map(({ directory }) => access(join(directory, 'dist'))),
  ]);

  const { archiveRootName, archivePath, checksumPath } = resolveMacosArm64CliArtifactPaths(version);
  await mkdir(releaseDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(join(tmpdir(), 'maka-cli-'));
  let complete = false;

  try {
    const installRoot = join(stagingRoot, 'install');
    await mkdir(installRoot, { recursive: true });
    await stageWorkspacePackages(installRoot, workspacePackages);
    await run('npm', macosArm64CliInstallArgs(), { cwd: installRoot, env });
    const dependencyPatches = await applyDependencyPatches(installRoot, { env, run });

    const nodeModulesDirectory = join(installRoot, 'node_modules');
    await rewriteCliVersion(installRoot, workspacePackages, version);
    await pruneNonTargetNativeBinaries(nodeModulesDirectory);
    await pruneTestArtifacts(nodeModulesDirectory);

    const archiveRoot = join(stagingRoot, archiveRootName);
    const binDirectory = join(archiveRoot, 'bin');
    const embeddedNodeDirectory = join(archiveRoot, 'libexec', 'node');
    await Promise.all([
      mkdir(binDirectory, { recursive: true }),
      mkdir(join(embeddedNodeDirectory, 'bin'), { recursive: true }),
    ]);
    await rename(nodeModulesDirectory, join(archiveRoot, 'libexec', 'node_modules'));
    for (const { workspacePath } of workspacePackages) {
      const source = join(installRoot, workspacePath);
      const target = join(archiveRoot, 'libexec', workspacePath);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    }
    await Promise.all([
      copyFile(execPath, join(embeddedNodeDirectory, 'bin', 'node')),
      copyFile(nodeLicensePath, join(embeddedNodeDirectory, 'LICENSE')),
      copyFile(join(repoRoot, 'LICENSE'), join(archiveRoot, 'LICENSE')),
      copyFile(join(repoRoot, 'NOTICE'), join(archiveRoot, 'NOTICE')),
      writeFile(join(binDirectory, 'maka'), macosArm64CliWrapper(), 'utf8'),
      writeFile(join(binDirectory, 'maka-agent'), macosArm64CliWrapper(), 'utf8'),
      writeFile(
        join(archiveRoot, 'RELEASE.json'),
        `${JSON.stringify(
          {
            version,
            nodeVersion: toolchain.nodeVersion,
            npmVersion: toolchain.npmVersion,
            dependencyPatches,
            workspacePackages: workspacePackages.map(({ name }) => name).sort(),
            signing: releaseSigning ? 'developer-id-notarized' : 'development',
          },
          null,
          2,
        )}\n`,
        'utf8',
      ),
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
    await assertWorkspaceLinks(archiveRoot, workspacePackages);

    let signing;
    if (releaseSigning) signing = await signCliBinaries(archiveRoot, { env, run });
    await createCliZip(archiveRoot, archivePath, { env, run });
    if (releaseSigning) await notarizeCliZip(archivePath, { env, inspect });

    const sha256 = await sha256File(archivePath);
    await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`, 'utf8');
    complete = true;
    return { archivePath, checksumPath, dependencyPatches, sha256, signing, version };
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
