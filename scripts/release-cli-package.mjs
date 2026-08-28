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

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';
import { validateCliReleaseArtifactMetrics } from './release-cli-artifact-policy.mjs';
import {
  isCurrentDevelopmentJavaScript,
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
  orderWorkspaceBuilds,
  renderNpmReadme,
  releaseNpmEnvironment,
  resolveReleaseWorkspacePackages,
  resolveWorkspaceReleaseFiles,
} from './release-cli-file-policy.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const cliSource = join(repoRoot, 'packages/cli');
const allowDirty = process.argv.includes('--allow-dirty');
const developmentBuild = process.argv.includes('--development');
const preparedTree = process.env.MAKA_CLI_RELEASE_PREPARED_TREE === '1';
const releaseRoot = join(cliSource, 'release');
const artifactRoot = developmentBuild ? createDevelopmentArtifactRoot() : releaseRoot;
const stageRoot = join(artifactRoot, 'package');
const peerPrebuildTargets = ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const privatePeerTarget = developmentBuild
  ? resolveDevelopmentPeerTarget()
  : `${process.platform}-${process.arch}`;
const unsupportedArguments = process.argv
  .slice(2)
  .filter((argument) => !['--allow-dirty', '--development'].includes(argument));
if (unsupportedArguments.length > 0) {
  throw new Error(`Unsupported release argument: ${unsupportedArguments.join(', ')}`);
}
const workspacePackages = resolveReleaseWorkspacePackages(repoRoot);
const internalPackageNames = workspacePackages
  .map(({ name }) => name)
  .filter((name) => name !== 'maka-agent');
const internalPackageSet = new Set(internalPackageNames);
const buildOrder = orderWorkspaceBuilds(workspacePackages);
const developmentGeneratedFiles = new Map([
  ['@maka/runtime', new Set(['workers/filesystem-worker.js'])],
]);
const strippedInstallScripts = new Map([
  // The clean repository install has already produced every generated file and
  // platform prebuild copied below. Do not run advisory postinstalls on an end
  // user's machine.
  ['node-pty@1.2.0-beta.15', new Set(['install', 'postinstall'])],
  ['protobufjs@7.6.5', new Set(['postinstall'])],
]);

try {
  main();
} catch (error) {
  if (developmentBuild) rmSync(artifactRoot, { recursive: true, force: true });
  throw error;
}

function main() {
  validateNodeVersion();
  if (!developmentBuild) validateReleaseNpmVersion();
  if (developmentBuild) {
    if (allowDirty || preparedTree) {
      throw new Error('--development cannot be combined with release build options');
    }
    console.warn('[release-cli] producing a private development tarball');
    buildRuntimeWorkspaces({ clean: false });
    packageCli(false);
    return;
  }
  if (!preparedTree && !allowDirty) {
    validateCleanWorktree();
    buildFromCleanDependencyTree();
    return;
  }
  if (preparedTree && allowDirty) {
    throw new Error('--allow-dirty cannot be combined with a prepared release tree');
  }
  if (preparedTree && existsSync(join(repoRoot, '.git'))) {
    throw new Error('A prepared release build must run inside the isolated source archive');
  }
  if (allowDirty) {
    console.warn(
      '[release-cli] WARNING: producing a private development tarball with publishing disabled',
    );
  }
  buildRuntimeWorkspaces({ clean: true });
  checkProductionAudit();
  runNpm(['run', 'check:cli-third-party-notices']);
  runNpm(['run', 'check:runtime-host-peer-dependencies']);
  runNpm(['run', 'check:runtime-host-peer-notices']);

  packageCli(preparedTree);
}

function packageCli(publishable) {
  const dependencyTree = readCliDependencyTree();
  const cli = dependencyTree.dependencies?.['maka-agent'];
  if (!cli) throw new Error('npm ls did not return the maka-agent workspace');

  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true, mode: 0o755 });
  copyCliRuntime();
  copyRuntimeHostPeerPrebuilds(publishable);
  const expectedDependencyManifests = copyDependencyClosure(cli);
  copyEvalMirror();
  copyReleaseDocuments();
  writeReleaseManifest(cli, publishable);
  validateStaging(publishable);

  const packOutput = JSON.parse(
    runNpm(['pack', stageRoot, '--json', '--pack-destination', artifactRoot], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const packs = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  const [pack] = packs;
  if (packs.length !== 1 || !pack?.filename || !Array.isArray(pack.files)) {
    throw new Error('npm pack did not return one JSON package result');
  }
  validateCliReleaseArtifactMetrics({
    compressedBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    entryCount: pack.entryCount,
  });
  const tarballPath = join(artifactRoot, pack.filename);
  validatePackedFiles(pack.files, expectedDependencyManifests, publishable);
  const sha256 = digestFile(tarballPath);
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${pack.filename}\n`, 'utf8');
  writeFileSync(
    join(artifactRoot, `${pack.filename}.files.json`),
    `${JSON.stringify(pack.files, null, 2)}\n`,
    'utf8',
  );

  console.log(`[release-cli] tarball: ${tarballPath}`);
  console.log(`[release-cli] sha256: ${sha256}`);
  console.log(
    `[release-cli] size: ${formatBytes(pack.size)} compressed, ${formatBytes(pack.unpackedSize)} unpacked, ${pack.entryCount} files`,
  );
}

function createDevelopmentArtifactRoot() {
  const developmentRoot = join(cliSource, '.development');
  mkdirSync(developmentRoot, { recursive: true, mode: 0o755 });
  const parent = process.env.MAKA_CLI_DEVELOPMENT_OUTPUT_ROOT?.trim();
  if (!parent) return mkdtempSync(join(developmentRoot, 'artifact-'));
  const resolvedParent = realpathSync(parent);
  const relativeParent = relative(realpathSync(developmentRoot), resolvedParent);
  if (
    !relativeParent ||
    relativeParent.startsWith('..') ||
    isAbsolute(relativeParent) ||
    !statSync(resolvedParent).isDirectory()
  ) {
    throw new Error('The CLI development output root must be a directory');
  }
  return join(resolvedParent, 'artifact');
}

function buildFromCleanDependencyTree() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-cli-release-build-'));
  const archivePath = join(temporaryRoot, 'source.tar');
  const cleanRoot = join(temporaryRoot, 'source');
  try {
    mkdirSync(cleanRoot, { recursive: true, mode: 0o755 });
    execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    execFileSync('tar', ['-xf', archivePath, '-C', cleanRoot], { stdio: 'inherit' });
    const preparedPeerPrebuilds = copyPeerPrebuildInputToCleanTree(cleanRoot);
    console.log('[release-cli] installing the committed dependency tree with npm ci');
    const cleanEnvironment = releaseNpmEnvironment(process.env, join(cleanRoot, '.npmrc'));
    execFileSync(
      'npm',
      ['ci'],
      npmSpawnOptions({ cwd: cleanRoot, env: cleanEnvironment, stdio: 'inherit' }),
    );
    execFileSync(process.execPath, [join(cleanRoot, 'scripts/release-cli-package.mjs')], {
      cwd: cleanRoot,
      env: {
        ...cleanEnvironment,
        MAKA_CLI_RELEASE_PREPARED_TREE: '1',
        ...(preparedPeerPrebuilds
          ? { MAKA_RUNTIME_HOST_PEER_PREBUILDS: preparedPeerPrebuilds }
          : {}),
      },
      stdio: 'inherit',
    });

    const cleanReleaseRoot = join(cleanRoot, 'packages/cli/release');
    if (!existsSync(cleanReleaseRoot)) {
      throw new Error('The isolated release build did not produce a release directory');
    }
    rmSync(releaseRoot, { recursive: true, force: true });
    cpSync(cleanReleaseRoot, releaseRoot, { recursive: true, preserveTimestamps: true });
    console.log(`[release-cli] copied the isolated release artifacts to ${releaseRoot}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function copyPeerPrebuildInputToCleanTree(cleanRoot) {
  const source = process.env.MAKA_RUNTIME_HOST_PEER_PREBUILDS?.trim();
  if (!source) return undefined;
  const destination = join(cleanRoot, '.release-runtime-host-peer-prebuilds');
  cpSync(realpathSync(source), destination, { recursive: true, preserveTimestamps: true });
  return destination;
}

function validateNodeVersion() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
}

function validateReleaseNpmVersion() {
  const packageManager = readJson(join(repoRoot, 'package.json')).packageManager;
  const requiredNpmVersion = /^npm@(.+)$/.exec(packageManager)?.[1];
  if (!requiredNpmVersion) {
    throw new Error(
      `The root packageManager must pin an exact npm version; found ${packageManager}`,
    );
  }
  const npmVersion = runNpm(['--version'], { encoding: 'utf8' }).trim();
  if (npmVersion !== requiredNpmVersion) {
    throw new Error(`npm ${requiredNpmVersion} is required; found ${npmVersion}`);
  }
}

function validateCleanWorktree() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (status) {
    throw new Error('Refusing to build a release tarball from a dirty worktree; commit first');
  }
}

function buildRuntimeWorkspaces(options) {
  if (options.clean) {
    for (const workspace of buildOrder) runNpm(['--workspace', workspace, 'run', 'clean']);
  }
  for (const workspace of buildOrder) runNpm(['--workspace', workspace, 'run', 'build']);
}

function checkProductionAudit() {
  const audit = spawnSync(
    'npm',
    ['audit', '--omit=dev', '--workspace', 'maka-agent', '--json'],
    npmSpawnOptions({
      cwd: repoRoot,
      encoding: 'utf8',
      env: releaseNpmEnvironment(process.env, join(repoRoot, '.npmrc')),
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const report = JSON.parse(audit.stdout || '{}');
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (audit.error || audit.status !== 0 || vulnerabilities?.total !== 0) {
    throw new Error(
      `CLI production dependency audit failed: ${JSON.stringify(vulnerabilities ?? report.error ?? audit.error)}`,
    );
  }
}

function readCliDependencyTree() {
  return JSON.parse(
    runNpm(['ls', '--workspace', 'maka-agent', '--omit=dev', '--all', '--long', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

function copyCliRuntime() {
  copyRuntimeDist(cliSource, stageRoot);
  chmodSync(join(stageRoot, 'dist/cli.js'), 0o755);
}

function copyDependencyClosure(cli) {
  const copiedDestinations = new Map();
  const visit = (node, parentDestination) => {
    for (const dependency of Object.values(node.dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      const peerPolicy = dependencyPeerPolicy(node, dependency.name);
      if (peerPolicy === 'optional') continue;
      if (typeof dependency.path === 'string' && existsSync(dependency.path)) {
        const destination = dependencyDestination(dependency);
        const source = realpathSync(dependency.path);
        const previous = copiedDestinations.get(destination);
        if (previous && previous !== source) {
          throw new Error(
            `Dependency destination collision at ${destination}: ${previous} vs ${source}`,
          );
        }
        if (!previous) {
          if (internalPackageSet.has(dependency.name)) {
            copyInternalPackage(source, destination);
          } else {
            copyThirdPartyPackage(source, destination);
          }
          copiedDestinations.set(destination, source);
        }
        if (
          peerPolicy === 'required' &&
          parentDestination &&
          destination === join(parentDestination, 'node_modules', ...dependency.name.split('/'))
        ) {
          addBundledDependency(parentDestination, dependency.name, dependency.version);
        }
        visit(dependency, destination);
      }
    }
  };
  visit(cli, stageRoot);

  const evalUndici = findDependency(cli, 'undici', '8.10.0');
  if (!evalUndici?.path || !existsSync(evalUndici.path)) {
    throw new Error('The installed CLI closure does not contain undici@8.10.0');
  }
  copyThirdPartyPackage(realpathSync(evalUndici.path), join(stageRoot, 'node_modules/undici'));
  copiedDestinations.set(join(stageRoot, 'node_modules/undici'), realpathSync(evalUndici.path));
  return [...copiedDestinations.keys()].map(
    (destination) => `${relative(stageRoot, destination).split(sep).join('/')}/package.json`,
  );
}

function dependencyPeerPolicy(parent, dependencyName) {
  if (!dependencyName || typeof parent.path !== 'string' || !existsSync(parent.path)) return 'none';
  const manifest = readJson(join(realpathSync(parent.path), 'package.json'));
  if (!manifest.peerDependencies?.[dependencyName]) return 'none';
  return manifest.peerDependenciesMeta?.[dependencyName]?.optional ? 'optional' : 'required';
}

function addBundledDependency(packageRoot, dependencyName, dependencyVersion) {
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [dependencyName]: dependencyVersion };
  manifest.bundledDependencies = [
    ...new Set([...(manifest.bundledDependencies ?? []), dependencyName]),
  ].sort();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function dependencyDestination(dependency) {
  if (internalPackageSet.has(dependency.name)) {
    return join(stageRoot, 'node_modules', ...dependency.name.split('/'));
  }
  if (dependency.name?.startsWith('@maka/')) {
    throw new Error(`Unexpected private workspace in the CLI closure: ${dependency.name}`);
  }
  const sourcePath = resolve(dependency.path);
  const rootModules = join(repoRoot, 'node_modules');
  if (isInside(rootModules, sourcePath)) {
    return join(stageRoot, 'node_modules', relative(rootModules, sourcePath));
  }
  for (const packageName of internalPackageNames) {
    const workspaceRoot = realpathSync(join(repoRoot, 'node_modules', ...packageName.split('/')));
    const workspaceModules = join(workspaceRoot, 'node_modules');
    if (isInside(workspaceModules, sourcePath)) {
      return join(
        stageRoot,
        'node_modules',
        ...packageName.split('/'),
        'node_modules',
        relative(workspaceModules, sourcePath),
      );
    }
  }
  throw new Error(`Dependency path is outside the supported installed tree: ${sourcePath}`);
}

function copyInternalPackage(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const manifest = readJson(join(source, 'package.json'));
  const allowedFields = [
    'name',
    'version',
    'description',
    'license',
    'type',
    'sideEffects',
    'main',
    'exports',
    'bin',
    'engines',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
  ];
  const releaseManifest = Object.fromEntries(
    allowedFields
      .filter((field) => manifest[field] !== undefined)
      .map((field) => [field, manifest[field]]),
  );
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  for (const releaseFile of resolveWorkspaceReleaseFiles(source, manifest)) {
    if (releaseFile === 'dist') copyRuntimeDist(source, destination, manifest.name);
    else copyDeclaredFile(source, destination, releaseFile);
  }
}

function copyRuntimeDist(source, destination, packageName = 'maka-agent') {
  const sourceDist = join(source, 'dist');
  if (!existsSync(sourceDist)) throw new Error(`Missing build output: ${sourceDist}`);
  copyTreeFiles(sourceDist, join(destination, 'dist'), (relativePath) => {
    if (isMakaDevelopmentArtifact(join('dist', relativePath))) return false;
    return (
      !developmentBuild ||
      isCurrentDevelopmentJavaScript(
        source,
        relativePath,
        developmentGeneratedFiles.get(packageName),
      )
    );
  });
}

function copyThirdPartyPackage(source, destination) {
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`Installed dependency has no package.json: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) => {
      if (path === source) return true;
      const relativePath = relative(source, path);
      return (
        !relativePath.split(sep).includes('node_modules') &&
        !isThirdPartyDevelopmentArtifact(relativePath)
      );
    },
  });
  stripReviewedInstallScripts(destination);
}

function stripReviewedInstallScripts(destination) {
  const manifestPath = join(destination, 'package.json');
  const manifest = readJson(manifestPath);
  const packageKey = `${manifest.name}@${manifest.version}`;
  const reviewed = strippedInstallScripts.get(packageKey);
  const present = ['preinstall', 'install', 'postinstall'].filter(
    (name) => typeof manifest.scripts?.[name] === 'string',
  );
  if (present.length === 0) return;
  if (!reviewed || present.some((name) => !reviewed.has(name))) {
    throw new Error(`${packageKey} has an unreviewed install script: ${present.join(', ')}`);
  }
  for (const name of present) delete manifest.scripts[name];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (packageKey === 'node-pty@1.2.0-beta.15') pruneNodePtyBuildInputs(destination);
}

function pruneNodePtyBuildInputs(destination) {
  // Without an explicit install script npm treats binding.gyp as a request to
  // run node-gyp. This release supports the platforms validated below through
  // shipped prebuilds, so source compilation would only add network/toolchain
  // dependence and bypass the reviewed artifact.
  for (const path of ['binding.gyp', 'scripts', 'src', 'third_party', 'typings']) {
    rmSync(join(destination, path), { recursive: true, force: true });
  }
  for (const path of walkFiles(destination)) {
    if (lstatSync(path).isFile() && /\.(?:map|pdb)$/.test(path)) rmSync(path, { force: true });
  }
}

function copyEvalMirror() {
  const stagedEval = join(stageRoot, 'node_modules/@maka/eval');
  const mirror = join(stageRoot, 'packages/eval');
  cpSync(stagedEval, mirror, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) =>
      path === stagedEval || !relative(stagedEval, path).split(sep).includes('node_modules'),
  });
}

function copyReleaseDocuments() {
  const readme = readFileSync(join(cliSource, 'README.md'), 'utf8');
  const disclaimer = readFileSync(join(repoRoot, 'DISCLAIMER-WIP'), 'utf8');
  writeFileSync(join(stageRoot, 'README.md'), renderNpmReadme(readme, disclaimer), 'utf8');
  copyFileSync(join(cliSource, 'README.zh-CN.md'), join(stageRoot, 'README.zh-CN.md'));
  copyFileSync(join(repoRoot, 'LICENSE'), join(stageRoot, 'LICENSE'));
  copyFileSync(join(repoRoot, 'NOTICE'), join(stageRoot, 'NOTICE'));
  // Incubator policy: podling releases carry the incubating disclaimer, kept
  // next to LICENSE/NOTICE. The npm tarball is a release like the installers.
  copyFileSync(join(repoRoot, 'DISCLAIMER-WIP'), join(stageRoot, 'DISCLAIMER-WIP'));
  copyFileSync(
    join(cliSource, 'THIRD_PARTY_NOTICES.txt'),
    join(stageRoot, 'THIRD_PARTY_NOTICES.txt'),
  );
  copyFileSync(
    join(cliSource, 'RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv'),
    join(stageRoot, 'RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv'),
  );
  copyFileSync(
    join(cliSource, 'RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt'),
    join(stageRoot, 'RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt'),
  );
}

function copyRuntimeHostPeerPrebuilds(publishable) {
  let sourceRoot = process.env.MAKA_RUNTIME_HOST_PEER_PREBUILDS?.trim();
  let generatedRoot;
  const targets = publishable
    ? peerPrebuildTargets
    : privatePeerTarget === 'none'
      ? []
      : [privatePeerTarget];
  if (targets.length === 0) return;
  if (!sourceRoot && !publishable) {
    const [target] = targets;
    buildDevelopmentPeerAddon(target);
    sourceRoot = generatedRoot = mkdtempSync(join(tmpdir(), 'maka-runtime-host-peer-prebuilds-'));
    const targetRoot = join(sourceRoot, target);
    mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
    copyFileSync(
      join(repoRoot, 'native/runtime-host-peer/target/release/maka_runtime_host_peer.node'),
      join(targetRoot, 'maka_runtime_host_peer.node'),
    );
  }
  if (!sourceRoot) {
    throw new Error('MAKA_RUNTIME_HOST_PEER_PREBUILDS must contain all release platform addons');
  }
  const destinationRoot = join(stageRoot, 'native/runtime-host-peer/prebuilds');
  try {
    for (const target of targets) {
      const source = join(sourceRoot, target, 'maka_runtime_host_peer.node');
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new Error(`Runtime Host peer prebuild is missing: ${target}`);
      }
      const destination = join(destinationRoot, target, 'maka_runtime_host_peer.node');
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      copyFileSync(source, destination);
    }
  } finally {
    if (generatedRoot) rmSync(generatedRoot, { recursive: true, force: true });
  }
}

function resolveDevelopmentPeerTarget() {
  const configured = process.env.MAKA_CLI_DEVELOPMENT_PEER_TARGET?.trim();
  const target = configured || `${process.platform}-${process.arch}`;
  if (target !== 'none' && !peerPrebuildTargets.includes(target)) {
    throw new Error(
      `MAKA_CLI_DEVELOPMENT_PEER_TARGET must be none or a supported target; found ${target}`,
    );
  }
  return target;
}

function buildDevelopmentPeerAddon(target) {
  const hostTarget = `${process.platform}-${process.arch}`;
  const buildScript = join(repoRoot, 'native/runtime-host-peer/build.mjs');
  if (target === hostTarget) {
    execFileSync(process.execPath, [buildScript], { cwd: repoRoot, stdio: 'inherit' });
    return;
  }
  const rustTarget = {
    'linux-arm64': 'aarch64-unknown-linux-gnu.2.28',
    'linux-x64': 'x86_64-unknown-linux-gnu.2.28',
  }[target];
  if (!rustTarget) {
    throw new Error(
      `Cannot build the ${target} direct-peer addon from ${hostTarget}; run Desktop on that target or provide MAKA_RUNTIME_HOST_PEER_PREBUILDS`,
    );
  }
  requireDevelopmentCommand(
    'zig',
    ['version'],
    `Cross-compiling the ${target} direct-peer addon requires Zig on PATH (CI uses 0.16.x)`,
  );
  requireDevelopmentCommand(
    'cargo-zigbuild',
    ['--version'],
    `Cross-compiling the ${target} direct-peer addon requires cargo-zigbuild (cargo install cargo-zigbuild --version 0.23.2 --locked)`,
  );
  execFileSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MAKA_RUNTIME_HOST_PEER_CARGO_SUBCOMMAND: 'zigbuild',
      MAKA_RUNTIME_HOST_PEER_CARGO_TARGET: rustTarget,
    },
    stdio: 'inherit',
  });
}

function requireDevelopmentCommand(command, args, message) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status === 0) return;
  throw new Error(`${message}; install it before setting up this development Runtime Host`);
}

function writeReleaseManifest(cli, publishable) {
  const source = readJson(join(cliSource, 'package.json'));
  const root = readJson(join(repoRoot, 'package.json'));
  if (source.version !== cli.version) {
    throw new Error(
      `CLI manifest and installed lockfile disagree: ${source.version} vs ${cli.version}`,
    );
  }
  const undici = findDependency(cli, 'undici', '8.10.0');
  const dependencies = { ...source.dependencies, undici: undici.version };
  const updateCompatibility = source.maka?.managedRuntimeHostUpdateCompatibility;
  if (!Number.isSafeInteger(updateCompatibility) || updateCompatibility < 1) {
    throw new Error(
      'CLI manifest must define a positive managed Runtime Host update compatibility',
    );
  }
  const manifest = {
    name: source.name,
    version: source.version,
    description: 'Apache Maka (Incubating), a local-first agent workspace for the terminal.',
    license: source.license,
    type: source.type,
    exports: {},
    bin: source.bin,
    maka: { managedRuntimeHostUpdateCompatibility: updateCompatibility },
    engines: root.engines,
    repository: {
      type: 'git',
      url: 'git+https://github.com/apache/maka.git',
      directory: 'packages/cli',
    },
    homepage: 'https://github.com/apache/maka#readme',
    bugs: { url: 'https://github.com/apache/maka/issues' },
    keywords: ['apache', 'ai', 'agent', 'cli', 'tui', 'local-first'],
    publishConfig: publishable
      ? {
          access: 'public',
          registry: 'https://registry.npmjs.org/',
          tag: source.version.includes('-') ? 'next' : 'latest',
        }
      : {
          access: 'restricted',
          registry: 'http://127.0.0.1:9/',
          tag: 'development',
        },
    files: [
      'dist',
      'native',
      'packages/eval',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE',
      'DISCLAIMER-WIP',
      'THIRD_PARTY_NOTICES.txt',
      'RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv',
      'RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt',
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies).sort(),
    ...(!publishable ? { private: true } : {}),
  };
  if (!publishable) {
    manifest.version = developmentPackageVersion(source.version, manifest);
  }
  writeFileSync(join(stageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function developmentPackageVersion(baseVersion, manifest) {
  const digest = createHash('sha256');
  for (const path of walkFiles(stageRoot)
    .filter((candidate) => lstatSync(candidate).isFile())
    .sort()) {
    digest.update(relative(stageRoot, path).split(sep).join('/'));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  const { version: _version, ...manifestIdentity } = manifest;
  digest.update('package.json\0');
  digest.update(JSON.stringify(manifestIdentity));
  digest.update('\0');
  return `${baseVersion}${baseVersion.includes('-') ? '.' : '-'}dev-${digest.digest('hex').slice(0, 12)}`;
}

function validateStaging(publishable) {
  const required = [
    'dist/cli.js',
    'README.zh-CN.md',
    'DISCLAIMER-WIP',
    'RUNTIME_HOST_PEER_DEPENDENCIES.rust.tsv',
    'RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt',
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'packages/eval/dist/harbor-external-subject.js',
    'packages/eval/harbor/relay_agent.py',
    'packages/eval/harbor/docker-compose-egress-proxy.yaml',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/fs-native-extensions/prebuilds/linux-x64/fs-native-extensions.node',
    'node_modules/fs-native-extensions/prebuilds/darwin-arm64/fs-native-extensions.node',
    'node_modules/fs-native-extensions/prebuilds/win32-x64/fs-native-extensions.node',
  ];
  if (publishable) {
    required.push(
      ...peerPrebuildTargets.map(
        (target) => `native/runtime-host-peer/prebuilds/${target}/maka_runtime_host_peer.node`,
      ),
    );
  } else if (privatePeerTarget !== 'none') {
    required.push(
      `native/runtime-host-peer/prebuilds/${privatePeerTarget}/maka_runtime_host_peer.node`,
    );
  }
  for (const path of required) {
    if (!existsSync(join(stageRoot, path)))
      throw new Error(`Required release file is missing: ${path}`);
  }
  assertPatchedFile(
    'node_modules/node-pty/lib/unixTerminal.js',
    'CustomWriteStream.prototype._ownsFileDescriptor',
  );
  assertPatchedFile('node_modules/@ai-sdk/provider-utils/dist/index.js', 'function absentIfBlank');

  const manifest = readJson(join(stageRoot, 'package.json'));
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (
      typeof specifier !== 'string' ||
      /^(?:file:|workspace:)|^[A-Za-z]:[\\/]|^\//.test(specifier)
    ) {
      throw new Error(`Release dependency must use a registry version: ${name}@${specifier}`);
    }
    if (
      name.startsWith('@maka/') &&
      !existsSync(join(stageRoot, 'node_modules', ...name.split('/')))
    ) {
      throw new Error(`Private dependency is not physically bundled: ${name}`);
    }
  }

  for (const path of walkFiles(stageRoot)) {
    const relativePath = relative(stageRoot, path);
    const status = lstatSync(path);
    if (status.isSymbolicLink())
      throw new Error(`Release staging contains a symlink: ${relativePath}`);
    if (!status.isFile()) continue;
    if (basename(path) === 'package.json') {
      const packageManifest = readJson(path);
      const installScript = ['preinstall', 'install', 'postinstall'].find(
        (name) => typeof packageManifest.scripts?.[name] === 'string',
      );
      if (installScript) {
        throw new Error(
          `Release dependency retains an install script: ${relativePath} (${installScript})`,
        );
      }
    }
    const content = readFileSync(path);
    if (content.includes(Buffer.from(repoRoot))) {
      throw new Error(`Release file contains the repository path: ${relativePath}`);
    }
  }
}

function validatePackedFiles(files, expectedDependencyManifests, publishable) {
  const paths = files.map((file) => file.path);
  for (const file of files) {
    const { path } = file;
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe tarball path: ${path}`);
    }
    const segments = path.split('/');
    const makaOwned =
      path.startsWith('dist/') ||
      path.startsWith('packages/eval/') ||
      (segments[0] === 'node_modules' && segments[1] === '@maka' && segments[3] !== 'node_modules');
    if (makaOwned && isMakaDevelopmentArtifact(path)) {
      throw new Error(`Development artifact escaped into the tarball: ${path}`);
    }
    if (!makaOwned && path.startsWith('node_modules/') && isThirdPartyDevelopmentArtifact(path)) {
      throw new Error(`Third-party development artifact escaped into the tarball: ${path}`);
    }
    const fileName = basename(path).toLowerCase();
    if (
      /^\.env(?:\..*)?$/.test(fileName) ||
      fileName === 'deepseek.key' ||
      /\.(?:key|p12|pfx|pem)$/.test(fileName) ||
      fileName === 'id_rsa' ||
      fileName === 'id_ed25519'
    ) {
      throw new Error(`Credential-like file escaped into the tarball: ${path}`);
    }
  }
  const requiredPacked = [
    'dist/cli.js',
    'DISCLAIMER-WIP',
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'packages/eval/harbor/relay_agent.py',
    ...(publishable || privatePeerTarget !== 'none' ? ['native/runtime-host-peer/prebuilds/'] : []),
  ];
  for (const suffix of requiredPacked) {
    if (
      !paths.some((path) =>
        suffix.endsWith('/') ? path.startsWith(suffix) : path.endsWith(suffix),
      )
    ) {
      throw new Error(`Required file was not packed: ${suffix}`);
    }
  }
  for (const manifestPath of expectedDependencyManifests) {
    if (!paths.includes(manifestPath)) {
      throw new Error(`Production dependency was not packed: ${manifestPath}`);
    }
  }
  const bin = files.find((file) => file.path === 'dist/cli.js');
  if (!bin || (process.platform !== 'win32' && (bin.mode & 0o111) === 0)) {
    throw new Error('The packed CLI entrypoint is not executable');
  }
}

function assertPatchedFile(path, marker) {
  const content = readFileSync(join(stageRoot, path), 'utf8');
  if (!content.includes(marker)) throw new Error(`Patched dependency marker is missing: ${path}`);
  console.log(`[release-cli] patch: ${path} sha256=${digestFile(join(stageRoot, path))}`);
}

function findDependency(root, name, version) {
  let result;
  const visit = (node) => {
    for (const dependency of Object.values(node.dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      if (dependency.name === name && dependency.version === version) result ??= dependency;
      visit(dependency);
    }
  };
  visit(root);
  return result;
}

function copyDeclaredFile(source, destination, relativePath) {
  const from = join(source, relativePath);
  if (!existsSync(from) || !statSync(from).isFile()) {
    throw new Error(`Declared Eval runtime asset is missing: ${from}`);
  }
  const to = join(destination, relativePath);
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  copyFileSync(from, to);
}

function copyTreeFiles(source, destination, allow) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    const relativePath = relative(source, path);
    if (entry.isDirectory()) {
      copyTreeFiles(path, join(destination, entry.name), (nestedPath) =>
        allow(join(entry.name, nestedPath)),
      );
    } else if (entry.isFile() && allow(relativePath)) {
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      copyFileSync(path, join(destination, entry.name));
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Maka build output contains an unexpected symlink: ${path}`);
    }
  }
}

function walkFiles(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walkFiles(path));
  }
  return paths;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runNpm(args, options = {}) {
  const environment = releaseNpmEnvironment(options.env ?? process.env, join(repoRoot, '.npmrc'));
  return execFileSync(
    'npm',
    args,
    npmSpawnOptions({
      cwd: repoRoot,
      stdio: options.encoding ? undefined : 'inherit',
      ...options,
      env: environment,
    }),
  );
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
