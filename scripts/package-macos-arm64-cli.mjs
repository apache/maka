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
import { createHash, randomBytes } from 'node:crypto';
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
import { resolveProductReleaseIdentity } from './product-release-identity.mjs';
import {
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
  releaseNpmEnvironment,
  resolveReleaseWorkspacePackages,
  resolveWorkspaceReleaseFiles,
} from './release-cli-file-policy.mjs';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(repoRoot, 'apps', 'desktop', 'release');
const dependencyPatchesDirectory = join(repoRoot, 'patches');
const cliPackageName = 'maka-agent';
const requiredSigningEnvironment = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];
export const OFFICIAL_NODE_RUNTIME_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
]);
// The official archive is validated verbatim above, but Apple rejects
// distribution software that keeps get-task-allow. Re-sign only the Node
// executable with the same runtime capabilities minus that development grant.
export const DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS = Object.freeze(
  OFFICIAL_NODE_RUNTIME_ENTITLEMENTS.filter(
    (entitlement) => entitlement !== 'com.apple.security.get-task-allow',
  ),
);

export function runCommand(command, args, options = {}) {
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
          `${command} ${(options.displayArgs ?? args).join(' ')} failed with ${
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
launcher=$0
while [ -L "$launcher" ]; do
  link_dir=$(CDPATH= cd -P "$(dirname "$launcher")" && pwd)
  link_target=$(readlink "$launcher")
  case "$link_target" in
    /*) launcher=$link_target ;;
    *) launcher=$link_dir/$link_target ;;
  esac
done
bin_dir=$(CDPATH= cd -P "$(dirname "$launcher")" && pwd)
libexec_dir=$(CDPATH= cd -P "$bin_dir/../libexec" && pwd)
MAKA_EVAL_MAKA_BUNDLE_PATH=$libexec_dir
export MAKA_EVAL_MAKA_BUNDLE_PATH
exec "$libexec_dir/node/bin/node" "$libexec_dir/node_modules/maka-agent/dist/cli.js" "$@"
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

export function standaloneInstallEnvironment(environment) {
  return releaseNpmEnvironment(environment, join(repoRoot, '.npmrc'));
}

export async function resolveCliWorkspacePackages() {
  return resolveReleaseWorkspacePackages(repoRoot, cliPackageName);
}

export async function pruneThirdPartyDevelopmentArtifacts(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path);
    if (isThirdPartyDevelopmentArtifact(relativePath)) {
      await rm(path, { recursive: entry.isDirectory(), force: true });
    } else if (entry.isDirectory()) {
      await pruneThirdPartyDevelopmentArtifacts(path, root);
    }
  }
}

export function standaloneInstallRootManifest(rootManifest, workspacePackages) {
  const { allowScripts: _allowScripts, ...staged } = rootManifest;
  return {
    ...staged,
    workspaces: workspacePackages.map(({ workspacePath }) => workspacePath),
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function stageWorkspacePackages(installRoot, workspacePackages) {
  const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  await Promise.all([
    writeFile(
      join(installRoot, 'package.json'),
      `${JSON.stringify(standaloneInstallRootManifest(rootManifest, workspacePackages), null, 2)}\n`,
      'utf8',
    ),
    copyFile(join(repoRoot, 'package-lock.json'), join(installRoot, 'package-lock.json')),
    ...workspacePackages.map(async ({ directory, manifest, workspacePath }) => {
      const targetDirectory = join(installRoot, workspacePath);
      await mkdir(targetDirectory, { recursive: true });
      await copyFile(join(directory, 'package.json'), join(targetDirectory, 'package.json'));
      await Promise.all(
        resolveWorkspaceReleaseFiles(directory, manifest).map(async (releaseFile) => {
          const source = join(directory, ...releaseFile.split('/'));
          const target = join(targetDirectory, ...releaseFile.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await cp(source, target, { recursive: true });
        }),
      );
      await pruneMakaDevelopmentArtifacts(targetDirectory);
    }),
  ]);
}

async function pruneMakaDevelopmentArtifacts(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (isMakaDevelopmentArtifact(relative(root, path))) {
      await rm(path, { recursive: entry.isDirectory(), force: true });
    } else if (entry.isDirectory()) {
      await pruneMakaDevelopmentArtifacts(path, root);
    }
  }
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

export async function dependencyPatchPackageName(patchName) {
  const patch = await readFile(join(dependencyPatchesDirectory, patchName), 'utf8');
  const target = patch.match(/^diff --git a\/node_modules\/((?:@[^/]+\/)?[^/]+)\//m)?.[1];
  if (!target) throw new Error(`Cannot resolve the target package for patch ${patchName}.`);
  return target;
}

export async function listApplicableDependencyPatchNames(nodeModulesDirectory) {
  const applicable = [];
  for (const patchName of await listDependencyPatchNames()) {
    const packageName = await dependencyPatchPackageName(patchName);
    try {
      await access(packageModulePath(nodeModulesDirectory, packageName));
      applicable.push(patchName);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return applicable;
}

export async function applyDependencyPatches(
  installRoot,
  { env = process.env, run = runCommand, patchPackageEntry } = {},
) {
  const patchNames = await listApplicableDependencyPatchNames(join(installRoot, 'node_modules'));
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

function packageModulePath(nodeModulesDirectory, packageName) {
  return join(nodeModulesDirectory, ...packageName.split('/'));
}

export async function assertNoDanglingSymlinks(directory, rootDirectory = directory) {
  const resolvedRoot = await realpath(rootDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = await realpath(path);
        const targetFromRoot = relative(resolvedRoot, target);
        if (
          targetFromRoot === '..' ||
          targetFromRoot.startsWith(`..${sep}`) ||
          isAbsolute(targetFromRoot)
        ) {
          throw new Error(`Symlink escapes the CLI artifact: ${path}`);
        }
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`Dangling symlink in CLI artifact: ${path}`);
        throw error;
      }
    } else if (entry.isDirectory()) {
      await assertNoDanglingSymlinks(path, rootDirectory);
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

function extractNodeEntitlements(output, expectedEntitlements, description) {
  const start = output.indexOf('<?xml');
  const end = output.indexOf('</plist>');
  if (start < 0 || end < start) {
    throw new Error(`${description} has no readable entitlement plist.`);
  }
  const plist = output.slice(start, end + '</plist>'.length);
  const allKeys = [...plist.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]).sort();
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/gu)]
    .map((match) => match[1])
    .sort();
  if (
    JSON.stringify(allKeys) !== JSON.stringify(expectedEntitlements) ||
    JSON.stringify(keys) !== JSON.stringify(expectedEntitlements)
  ) {
    throw new Error(`${description} entitlements do not match the reviewed contract.`);
  }
  return plist;
}

export function extractOfficialNodeEntitlements(output) {
  return extractNodeEntitlements(
    output,
    OFFICIAL_NODE_RUNTIME_ENTITLEMENTS,
    'Official Node runtime',
  );
}

export function extractDistributionNodeEntitlements(output) {
  return extractNodeEntitlements(
    output,
    DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS,
    'Distribution Node runtime',
  );
}

export function distributionNodeEntitlements(officialEntitlements) {
  const plist = extractOfficialNodeEntitlements(officialEntitlements);
  const distributionPlist = plist.replace(
    /\s*<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/u,
    '',
  );
  return extractDistributionNodeEntitlements(distributionPlist);
}

async function inspectReleaseToolchain({ execPath, env, inspect, toolchain }) {
  const [nodeVersion, npmVersion, architectures, signature, entitlements, dependencies] =
    await Promise.all([
      inspect(execPath, ['-p', 'process.versions.node'], { env }),
      inspect('npm', ['--version'], { env }),
      inspect('lipo', ['-archs', execPath], { env }),
      inspect('codesign', ['-d', '--verbose=4', execPath], { env }),
      inspect('codesign', ['-d', '--entitlements', ':-', execPath], { env }),
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
  return extractOfficialNodeEntitlements(`${entitlements.stdout}\n${entitlements.stderr}`);
}

export async function assertOfficialNodeArchive(
  archivePath,
  toolchain,
  { hashFile = sha256File } = {},
) {
  if (basename(archivePath) !== toolchain.nodeArchive) {
    throw new Error(`CLI Node archive must be named ${toolchain.nodeArchive}.`);
  }
  const actualSha256 = await hashFile(archivePath);
  if (actualSha256 !== toolchain.nodeArchiveSha256) {
    throw new Error(
      `CLI Node archive digest mismatch: expected ${toolchain.nodeArchiveSha256}, found ${actualSha256}.`,
    );
  }
  return actualSha256;
}

async function extractOfficialNodeRuntime(stagingRoot, archivePath, toolchain, { env, run }) {
  await access(archivePath);
  await assertOfficialNodeArchive(archivePath, toolchain);
  const extractionRoot = join(stagingRoot, 'official-node');
  await mkdir(extractionRoot, { recursive: true });
  await run('tar', ['-xJf', archivePath, '-C', extractionRoot], { env });
  const distributionRoot = join(extractionRoot, `node-v${toolchain.nodeVersion}-darwin-arm64`);
  const execPath = join(distributionRoot, 'bin', 'node');
  const licensePath = join(distributionRoot, 'LICENSE');
  await Promise.all([access(execPath), access(licensePath)]);
  return { execPath, licensePath };
}

export async function collectPackagedProductionDependencies(
  nodeModulesDirectory,
  workspaceNames = new Set(),
) {
  const dependencies = new Set();

  async function visitNodeModules(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const packageDirectories = [];
    for (const entry of entries) {
      if (entry.name === '.bin') continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const scopedEntry of await readdir(path, { withFileTypes: true })) {
          packageDirectories.push(join(path, scopedEntry.name));
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        packageDirectories.push(path);
      }
    }
    for (const packageDirectory of packageDirectories) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (
        !workspaceNames.has(manifest.name) &&
        typeof manifest.name === 'string' &&
        typeof manifest.version === 'string'
      ) {
        dependencies.add(`${manifest.name}@${manifest.version}`);
      }
      await visitNodeModules(join(packageDirectory, 'node_modules'));
    }
  }

  await visitNodeModules(nodeModulesDirectory);
  return [...dependencies].sort();
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

export async function inspectNativeArtifacts(
  directory,
  { inspect = inspectCommand, concurrency = 16 } = {},
) {
  const files = await findFiles(directory, () => true);
  const foreignBinaries = [];
  const machOBinaries = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), files.length) },
    async () => {
      while (nextIndex < files.length) {
        const path = files[nextIndex++];
        const result = await inspect('file', ['-b', path]);
        if (/\bMach-O\b/.test(result.stdout)) machOBinaries.push(path);
        else if (/^(?:ELF\b|PE32\b|MS-DOS executable\b)/.test(result.stdout)) {
          foreignBinaries.push(path);
        }
      }
    },
  );
  await Promise.all(workers);
  return { foreignBinaries: foreignBinaries.sort(), machOBinaries: machOBinaries.sort() };
}

export async function findMachOBinaries(directory, options = {}) {
  return (await inspectNativeArtifacts(directory, options)).machOBinaries;
}

export function isMacosArm64MachO(architectures, buildVersion) {
  return architectures.trim() === 'arm64' && /^\s*platform MACOS\s*$/m.test(buildVersion);
}

export function macosArm64MachOAction(architectures, buildVersion) {
  const architectureList = architectures.trim().split(/\s+/u).filter(Boolean);
  if (!architectureList.includes('arm64') || !/^\s*platform MACOS\s*$/m.test(buildVersion)) {
    return 'remove';
  }
  return architectureList.length === 1 ? 'keep' : 'thin';
}

async function pruneNonTargetNativeBinaries(nodeModulesDirectory, { inspect, run }) {
  const { foreignBinaries, machOBinaries } = await inspectNativeArtifacts(nodeModulesDirectory, {
    inspect,
  });
  await Promise.all(foreignBinaries.map((path) => rm(path, { force: true })));
  for (const binaryPath of machOBinaries) {
    const [architectures, buildVersion] = await Promise.all([
      inspect('lipo', ['-archs', binaryPath]),
      inspect('xcrun', ['vtool', '-show-build', binaryPath]),
    ]);
    const action = macosArm64MachOAction(architectures.stdout, buildVersion.stdout);
    if (action === 'remove') {
      await rm(binaryPath, { force: true });
    } else if (action === 'thin') {
      const thinnedPath = `${binaryPath}.arm64`;
      try {
        await run('lipo', [binaryPath, '-thin', 'arm64', '-output', thinnedPath]);
        const [thinnedArchitectures, thinnedBuildVersion] = await Promise.all([
          inspect('lipo', ['-archs', thinnedPath]),
          inspect('xcrun', ['vtool', '-show-build', thinnedPath]),
        ]);
        if (!isMacosArm64MachO(thinnedArchitectures.stdout, thinnedBuildVersion.stdout)) {
          throw new Error(`Could not thin Mach-O file to macOS arm64: ${binaryPath}`);
        }
        await rename(thinnedPath, binaryPath);
      } finally {
        await rm(thinnedPath, { force: true });
      }
    }
  }
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

export function decodeSigningCertificate(value) {
  const encoded = value?.replace(/[\t\n\r ]+/gu, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error('CSC_LINK must contain one base64-encoded PKCS12 certificate.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) {
    throw new Error('CSC_LINK must contain one base64-encoded PKCS12 certificate.');
  }
  return { bytes };
}

export function parseDeveloperIdApplicationIdentity(output) {
  const identities = [...output.matchAll(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/gmu)]
    .map((match) => ({
      hash: match[1].toUpperCase(),
      name: match[2],
      teamIdentifier: / \(([A-Z0-9]{10})\)$/u.exec(match[2])?.[1],
    }))
    .filter(({ name }) => name.startsWith('Developer ID Application:'));
  if (identities.length !== 1) {
    throw new Error('CLI signing keychain must contain one Developer ID Application identity.');
  }
  if (!identities[0].teamIdentifier) {
    throw new Error('Developer ID Application identity has no exact Apple Team ID.');
  }
  return identities[0];
}

export function assertExpectedAppleTeam(identity, expectedTeamIdentifier) {
  if (identity.teamIdentifier !== expectedTeamIdentifier) {
    throw new Error(
      `CLI signing identity belongs to Apple team ${identity.teamIdentifier}, expected ${expectedTeamIdentifier}.`,
    );
  }
  return identity;
}

export async function createSigningKeychain({ env, expectedTeamIdentifier, run, inspect }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-cli-signing-'));
  const certificatePath = join(temporaryRoot, 'identity.p12');
  const pemPath = join(temporaryRoot, 'identity.pem');
  const keychainFile = join(temporaryRoot, 'signing.keychain-db');
  const keychainPassword = randomBytes(32).toString('hex');
  let created = false;
  const cleanup = async () => {
    let keychainDeletionError;
    if (created) {
      try {
        await run('security', ['delete-keychain', keychainFile], { env });
      } catch (error) {
        keychainDeletionError = error;
      } finally {
        created = false;
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      if (keychainDeletionError) {
        throw new AggregateError(
          [keychainDeletionError, error],
          'Signing keychain and temporary credential cleanup both failed',
        );
      }
      throw error;
    }
    if (keychainDeletionError) throw keychainDeletionError;
  };

  try {
    await writeFile(certificatePath, decodeSigningCertificate(env.CSC_LINK).bytes, { mode: 0o600 });
    await run('security', ['create-keychain', '-p', keychainPassword, keychainFile], {
      env,
      displayArgs: ['create-keychain', '-p', '<redacted>', keychainFile],
    });
    created = true;
    await run('security', ['unlock-keychain', '-p', keychainPassword, keychainFile], {
      env,
      displayArgs: ['unlock-keychain', '-p', '<redacted>', keychainFile],
    });
    await run('security', ['set-keychain-settings', '-lut', '21600', keychainFile], { env });
    await run(
      'openssl',
      [
        'pkcs12',
        '-in',
        certificatePath,
        '-nodes',
        '-passin',
        'env:CSC_KEY_PASSWORD',
        '-out',
        pemPath,
      ],
      { env },
    );
    await chmod(pemPath, 0o600);
    await run('security', ['import', pemPath, '-k', keychainFile, '-T', '/usr/bin/codesign'], {
      env,
    });
    await run(
      'security',
      [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:',
        '-s',
        '-k',
        keychainPassword,
        keychainFile,
      ],
      {
        env,
        displayArgs: [
          'set-key-partition-list',
          '-S',
          'apple-tool:,apple:',
          '-s',
          '-k',
          '<redacted>',
          keychainFile,
        ],
      },
    );
    const identityOutput = await inspect(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', keychainFile],
      { env },
    );
    const identity = assertExpectedAppleTeam(
      parseDeveloperIdApplicationIdentity(identityOutput.stdout),
      expectedTeamIdentifier,
    );
    return {
      cleanup,
      directory: temporaryRoot,
      identity,
      keychainFile,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function signCliBinaries(
  machOBinaries,
  { env, expectedTeamIdentifier, run, inspect, nodeEntitlements, nodePath },
) {
  assertReleaseSigningEnvironment(env);
  const signing = await createSigningKeychain({ env, expectedTeamIdentifier, run, inspect });
  try {
    const nodeEntitlementsPath = join(signing.directory, 'node-entitlements.plist');
    await writeFile(nodeEntitlementsPath, `${nodeEntitlements}\n`, { mode: 0o600 });
    for (const binaryPath of machOBinaries) {
      const entitlements =
        resolve(binaryPath) === resolve(nodePath) ? ['--entitlements', nodeEntitlementsPath] : [];
      await run(
        'codesign',
        [
          '--force',
          '--options',
          'runtime',
          '--timestamp',
          ...entitlements,
          '--sign',
          signing.identity.hash,
          '--keychain',
          signing.keychainFile,
          binaryPath,
        ],
        { env },
      );
      await run('codesign', ['--verify', '--strict', '--verbose=2', binaryPath], { env });
    }
    const signedNodeEntitlements = await inspect(
      'codesign',
      ['-d', '--entitlements', ':-', nodePath],
      { env },
    );
    extractDistributionNodeEntitlements(
      `${signedNodeEntitlements.stdout}\n${signedNodeEntitlements.stderr}`,
    );
    return {
      identityName: signing.identity.name,
      machOBinaryCount: machOBinaries.length,
      teamIdentifier: signing.identity.teamIdentifier,
    };
  } finally {
    await signing.cleanup();
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
  env = process.env,
  run = runCommand,
  inspect = inspectCommand,
  releaseSigning = env.MAKA_CLI_RELEASE_SIGNING === '1',
  nodeArchivePath = env.MAKA_CLI_NODE_ARCHIVE,
} = {}) {
  assertMacosArm64CliHost(platform, arch);

  const [rootManifest, desktopManifest, cliManifest, workspacePackages, sourceCommitResult] =
    await Promise.all([
      readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8').then(JSON.parse),
      resolveCliWorkspacePackages(),
      inspect('git', ['rev-parse', 'HEAD']),
    ]);
  const sourceCommit = sourceCommitResult.stdout.trim();
  const identity = resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest,
    cliManifest,
    sha: sourceCommit,
  });
  if (releaseSigning) assertReleaseSigningEnvironment(env);
  if (!nodeArchivePath) {
    throw new Error(`Set MAKA_CLI_NODE_ARCHIVE to the verified ${identity.nodeArchive} path.`);
  }

  const version = identity.version;
  await Promise.all([
    access(join(repoRoot, 'DISCLAIMER-WIP')),
    access(join(repoRoot, 'LICENSE')),
    access(join(repoRoot, 'NOTICE')),
    ...workspacePackages.map(({ directory }) => access(join(directory, 'dist'))),
  ]);

  const { archiveRootName, archivePath, checksumPath } = resolveMacosArm64CliArtifactPaths(version);
  await mkdir(releaseDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(join(tmpdir(), 'maka-cli-'));
  let complete = false;

  try {
    const officialNode = await extractOfficialNodeRuntime(
      stagingRoot,
      resolve(nodeArchivePath),
      identity,
      { env, run },
    );
    const officialNodeEntitlements = await inspectReleaseToolchain({
      execPath: officialNode.execPath,
      env,
      inspect,
      toolchain: identity,
    });
    const nodeEntitlements = distributionNodeEntitlements(officialNodeEntitlements);

    const installRoot = join(stagingRoot, 'install');
    await mkdir(installRoot, { recursive: true });
    await stageWorkspacePackages(installRoot, workspacePackages);
    await run('npm', macosArm64CliInstallArgs(), {
      cwd: installRoot,
      env: standaloneInstallEnvironment(env),
    });
    const dependencyPatches = await applyDependencyPatches(installRoot, { env, run });
    const productionDependencies = await collectPackagedProductionDependencies(
      join(installRoot, 'node_modules'),
      new Set(workspacePackages.map(({ name }) => name)),
    );

    const nodeModulesDirectory = join(installRoot, 'node_modules');
    await pruneNonTargetNativeBinaries(nodeModulesDirectory, { inspect, run });
    await pruneThirdPartyDevelopmentArtifacts(nodeModulesDirectory);

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
      copyFile(officialNode.execPath, join(embeddedNodeDirectory, 'bin', 'node')),
      copyFile(officialNode.licensePath, join(embeddedNodeDirectory, 'LICENSE')),
      copyFile(join(repoRoot, 'DISCLAIMER-WIP'), join(archiveRoot, 'DISCLAIMER-WIP')),
      copyFile(join(repoRoot, 'LICENSE'), join(archiveRoot, 'LICENSE')),
      copyFile(join(repoRoot, 'NOTICE'), join(archiveRoot, 'NOTICE')),
      writeFile(join(binDirectory, 'maka'), macosArm64CliWrapper(), 'utf8'),
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
    ]);
    await assertWorkspaceLinks(archiveRoot, workspacePackages);

    const thirdPartyNoticesPath = join(archiveRoot, 'THIRD_PARTY_NOTICES.txt');
    await copyFile(
      join(repoRoot, 'packages', 'cli', 'THIRD_PARTY_NOTICES.txt'),
      thirdPartyNoticesPath,
    );
    const thirdPartyNoticesSha256 = await sha256File(thirdPartyNoticesPath);

    const machOBinaries = await findMachOBinaries(archiveRoot, { inspect });
    if (machOBinaries.length === 0) throw new Error('CLI artifact contains no Mach-O binaries.');
    const releaseMetadata = {
      schemaVersion: 1,
      product: 'Maka',
      version,
      sourceCommit,
      platform: 'macos',
      architecture: 'arm64',
      publicCommands: identity.publicCommands,
      node: {
        version: identity.nodeVersion,
        sourceUrl: identity.nodeSourceUrl,
        archive: identity.nodeArchive,
        archiveSha256: identity.nodeArchiveSha256,
        entitlements: releaseSigning
          ? DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS
          : OFFICIAL_NODE_RUNTIME_ENTITLEMENTS,
      },
      npmVersion: identity.npmVersion,
      dependencyPatches,
      productionDependencies,
      thirdPartyNoticesSha256,
      workspacePackages: workspacePackages.map(({ name }) => name).sort(),
      machOBinaries: machOBinaries.map((path) => relative(archiveRoot, path)).sort(),
      signing: releaseSigning ? 'developer-id-notarized' : 'development',
      signingTeamIdentifier: releaseSigning ? identity.appleTeamIdentifier : null,
    };
    await writeFile(
      join(archiveRoot, 'RELEASE.json'),
      `${JSON.stringify(releaseMetadata, null, 2)}\n`,
      'utf8',
    );

    let signing;
    if (releaseSigning) {
      signing = await signCliBinaries(machOBinaries, {
        env,
        expectedTeamIdentifier: identity.appleTeamIdentifier,
        run,
        inspect,
        nodeEntitlements,
        nodePath: join(embeddedNodeDirectory, 'bin', 'node'),
      });
    }
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
