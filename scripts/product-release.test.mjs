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

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import desktopBuilderConfig from '../apps/desktop/electron-builder.config.mjs';
import {
  parseAsfSourceReferenceTag,
  resolveProductManifestIdentity,
  resolveProductReleaseIdentity,
} from './product-release-identity.mjs';
import {
  assertExpectedAppleTeam,
  createSigningKeychain,
  decodeSigningCertificate,
  DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS,
  distributionNodeEntitlements,
  extractDistributionNodeEntitlements,
  extractOfficialNodeEntitlements,
  macosArm64MachOAction,
  macosArm64CliWrapper,
  parseDeveloperIdApplicationIdentity,
  pruneThirdPartyDevelopmentArtifacts,
  resolveCliWorkspacePackages,
  runCommand,
  stageWorkspacePackages,
  standaloneInstallEnvironment,
  standaloneInstallRootManifest,
} from './package-macos-arm64-cli.mjs';
import { resolveWorkspaceReleaseFiles } from './release-cli-file-policy.mjs';
import { isTuiReadyOutput, verifyQuarantinedExecution } from './verify-macos-arm64-cli.mjs';
import { makePtyProbe } from './verify-packaged-app.mjs';
import { ensureProductTag } from './product-release-tag.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');

const rootManifest = {
  version: '1.2.3',
  packageManager: 'npm@11.19.0',
  releaseToolchain: {
    appleTeamIdentifier: 'FABM2QUA8Q',
    node: '24.18.1',
    nodeDarwinArm64Sha256: '1'.repeat(64),
  },
};

test('one root version defines every product artifact from one source commit', () => {
  const identity = resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest: { version: '1.2.3' },
    cliManifest: { version: '1.2.3', bin: { maka: './dist/cli.js' } },
    sha: 'a'.repeat(40),
    sourceReferenceTag: 'v1.2.3-incubating-rc2',
  });

  assert.equal(identity.version, '1.2.3');
  assert.equal(identity.isPrerelease, false);
  assert.equal(identity.tag, 'v1.2.3');
  assert.equal(identity.sourceCommit, 'a'.repeat(40));
  assert.equal(identity.sourceReferenceTag, 'v1.2.3-incubating-rc2');
  assert.equal(identity.runtimeHostSetupPackage, 'maka-agent@1.2.3');
  assert.deepEqual(identity.publicCommands, ['maka']);
  assert.equal(identity.appleTeamIdentifier, 'FABM2QUA8Q');
  assert.equal(identity.nodeVersion, '24.18.1');
  assert.equal(identity.nodeArchive, 'node-v24.18.1-darwin-arm64.tar.xz');
  assert.equal(identity.nodeArchiveSha256, '1'.repeat(64));
  assert.equal(
    identity.nodeSourceUrl,
    'https://nodejs.org/download/release/v24.18.1/node-v24.18.1-darwin-arm64.tar.xz',
  );
  assert.equal(identity.npmVersion, '11.19.0');
  assert.equal(identity.dmg, 'Maka-1.2.3-mac-arm64.dmg');
  assert.equal(identity.exe, 'Maka-1.2.3-win-x64.exe');
  assert.equal(identity.cliArchive, 'Maka-1.2.3-cli-mac-arm64.zip');
  assert.equal(Object.hasOwn(identity, 'sourceArchive'), false);
  assert.deepEqual(identity.artifacts, {
    'desktop-macos': [
      'Maka-1.2.3-mac-arm64.dmg',
      'Maka-1.2.3-mac-arm64.dmg.sha256',
      'Maka-1.2.3-mac-arm64.zip',
      'Maka-1.2.3-mac-arm64.zip.blockmap',
      'latest-mac.yml',
    ],
    'desktop-windows': [
      'Maka-1.2.3-win-x64.exe',
      'Maka-1.2.3-win-x64.exe.blockmap',
      'Maka-1.2.3-win-x64.exe.sha256',
      'Maka-1.2.3-win-x64.zip',
      'Maka-1.2.3-win-x64.zip.sha256',
      'latest.yml',
    ],
    'cli-macos-arm64': ['Maka-1.2.3-cli-mac-arm64.zip', 'Maka-1.2.3-cli-mac-arm64.zip.sha256'],
  });
});

test('the standalone launcher identifies its installed Eval bundle root', async (t) => {
  const archiveRoot = await mkdtemp(join(tmpdir(), 'maka-standalone-launcher-'));
  t.after(() => rm(archiveRoot, { recursive: true, force: true }));
  const launcher = join(archiveRoot, 'bin', 'maka');
  const node = join(archiveRoot, 'libexec', 'node', 'bin', 'node');
  await Promise.all([
    mkdir(join(archiveRoot, 'bin'), { recursive: true }),
    mkdir(join(archiveRoot, 'libexec', 'node', 'bin'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(launcher, macosArm64CliWrapper()),
    writeFile(
      node,
      `#!/bin/sh
expected=$(CDPATH= cd -P "$(dirname "$0")/../.." && pwd)
[ "$MAKA_EVAL_MAKA_BUNDLE_PATH" = "$expected" ]
printf verified
`,
    ),
  ]);
  await Promise.all([chmod(launcher, 0o755), chmod(node, 0o755)]);

  const { stdout } = await execFileAsync('bash', [launcher]);

  assert.equal(stdout, 'verified');
});

test('the product identity classifies prereleases once for every publication surface', () => {
  const version = '1.2.3-beta.2';
  const identity = resolveProductReleaseIdentity({
    rootManifest: { ...rootManifest, version },
    desktopManifest: { version },
    cliManifest: { version, bin: { maka: './dist/cli.js' } },
    sha: 'a'.repeat(40),
    sourceReferenceTag: `v${version}-incubating-rc1`,
  });

  assert.equal(identity.isPrerelease, true);
  assert.equal(identity.tag, `v${version}`);
});

test('Desktop packaging derives the Runtime Host setup package from product manifests', async () => {
  const manifestIdentity = resolveProductManifestIdentity({
    rootManifest,
    desktopManifest: { version: '1.2.3' },
    cliManifest: { version: '1.2.3', bin: { maka: './dist/cli.js' } },
  });
  assert.equal(manifestIdentity.runtimeHostSetupPackage, 'maka-agent@1.2.3');

  const checkedRootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(desktopBuilderConfig.extraMetadata, {
    runtimeHostSetupPackage: `maka-agent@${checkedRootManifest.version}`,
  });
  assert.deepEqual(desktopBuilderConfig.publish, [
    { provider: 'github', owner: 'apache', repo: 'maka' },
  ]);
});

test('Desktop packaging does not distribute the retired bundled Git runtime', () => {
  const resources = desktopBuilderConfig.extraResources.map(({ from, to }) => ({ from, to }));
  assert.equal(
    resources.some(({ from }) => from.includes('dugite')),
    false,
  );
  assert.equal(
    resources.some(({ to }) => to === 'git' || to.startsWith('licenses/git')),
    false,
  );
  assert.equal(
    resources.some(({ to }) => to === 'bundled-git.json'),
    false,
  );
  assert.equal(
    resources.some(({ to }) => to.startsWith('licenses/dugite')),
    false,
  );
});

test('platform package verifiers keep Git checks out of current artifacts', async () => {
  const windowsSource = await readFile(join(repoRoot, 'scripts', 'verify-windows-x64.mjs'), 'utf8');
  assert.match(
    windowsSource,
    /bundledGitContract: requiresCurrentContract \? ['"]forbidden['"] : ['"]legacy-required['"]/u,
  );
  assert.match(
    windowsSource,
    /if \(requiresCurrentContract\) await assertPackagedDependencyClosure\(resources\);\s*else await requirePath\(join\(resources, ['"]git['"]/u,
  );

  const macosSource = await readFile(
    join(repoRoot, 'scripts', 'verify-macos-arm64-dmg.mjs'),
    'utf8',
  );
  assert.doesNotMatch(macosSource, /requirePath\(join\(resources, ['"]git['"]/u);
});

test('the packaged-app probe rejects a mismatched Runtime Host setup package', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'maka-packaged-manifest-'));
  try {
    const manifestPath = join(fixture, 'package.json');
    const ptyDirectory = join(fixture, 'node_modules', 'node-pty');
    await mkdir(ptyDirectory, { recursive: true });
    await Promise.all([
      writeFile(manifestPath, JSON.stringify({ runtimeHostSetupPackage: 'maka-agent@1.2.3' })),
      writeFile(
        join(ptyDirectory, 'index.js'),
        `module.exports = { spawn() { return {
  onData(listener) { queueMicrotask(() => listener('maka-node-pty-ok')); },
  onExit(listener) { setImmediate(() => listener({ exitCode: 0 })); },
}; } };\n`,
      ),
    ]);
    await execFileAsync(process.execPath, [
      '-e',
      makePtyProbe('/bin/echo', ['maka-node-pty-ok'], 'maka-agent@1.2.3'),
      manifestPath,
    ]);
    await assert.rejects(
      execFileAsync(process.execPath, [
        '-e',
        makePtyProbe('/bin/echo', ['maka-node-pty-ok'], 'maka-agent@1.2.4'),
        manifestPath,
      ]),
      /Packaged Runtime Host setup package mismatch/u,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('product releases accept only an exact same-version ASF source reference', () => {
  assert.deepEqual(parseAsfSourceReferenceTag('v1.2.3-incubating-rc2'), {
    rcNumber: '2',
    tag: 'v1.2.3-incubating-rc2',
    version: '1.2.3',
  });
  for (const tag of ['v1.2.3-incubating-rc0', 'v1.2.3-incubating-rc01', 'v1.2.3-rc1']) {
    assert.throws(() => parseAsfSourceReferenceTag(tag), /ASF source reference must match/u);
  }
  assert.throws(
    () =>
      resolveProductReleaseIdentity({
        rootManifest,
        desktopManifest: { version: '1.2.3' },
        cliManifest: { version: '1.2.3', bin: { maka: './dist/cli.js' } },
        sha: 'a'.repeat(40),
        sourceReferenceTag: 'v1.2.4-incubating-rc1',
      }),
    /source reference version 1\.2\.4 does not match product 1\.2\.3/u,
  );
});

test('the product identity CLI uses the checked-out commit outside GitHub Actions', async () => {
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  delete env.GITHUB_OUTPUT;
  const [{ stdout }, { stdout: head }, manifest] = await Promise.all([
    execFileAsync(process.execPath, [join(repoRoot, 'scripts/product-release-identity.mjs')], {
      cwd: repoRoot,
      env,
    }),
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(stdout.trim(), `Product release v${manifest.version} from ${head.trim()}`);
  await assert.rejects(
    execFileAsync(process.execPath, [join(repoRoot, 'scripts/product-release-identity.mjs')], {
      cwd: repoRoot,
      env: { ...env, EXPECTED_PRODUCT_VERSION: '9.9.9' },
    }),
    /does not match requested release/u,
  );
});

test('product release identity rejects a non-canonical version at its boundary', () => {
  const version = '01.2.3';
  assert.throws(
    () =>
      resolveProductReleaseIdentity({
        rootManifest: { ...rootManifest, version },
        desktopManifest: { version },
        cliManifest: { version, bin: { maka: './dist/cli.js' } },
        sha: 'a'.repeat(40),
      }),
    /valid product release version/u,
  );
});

test('product tag creation is exact and idempotent but rejects a conflicting commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-product-tag-'));
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  try {
    await execFileAsync('git', ['init', '--bare', remote]);
    await mkdir(source);
    await execFileAsync('git', ['init'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'Maka release test'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 'release-test@example.invalid'], {
      cwd: source,
    });
    await writeFile(join(source, 'source.txt'), 'one\n');
    await execFileAsync('git', ['add', 'source.txt'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'first'], { cwd: source });
    const first = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
    ).stdout.trim();

    assert.equal(
      await ensureProductTag({ cwd: source, remote, tag: 'v1.2.3', source: first }),
      'created',
    );
    assert.equal(
      await ensureProductTag({ cwd: source, remote, tag: 'v1.2.3', source: first }),
      'existing',
    );

    await writeFile(join(source, 'source.txt'), 'two\n');
    await execFileAsync('git', ['commit', '-am', 'second'], { cwd: source });
    const second = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
    ).stdout.trim();
    await assert.rejects(
      ensureProductTag({ cwd: source, remote, tag: 'v1.2.3', source: second }),
      /points to .* instead of/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone verification recognizes the current TUI status line through ANSI output', () => {
  assert.equal(
    isTuiReadyOutput(
      '\u001b[1mMaka\u001b[22m\u001b[2m · \u001b[22m\u001b[2mAuto\u001b[22m\u001b[2m · model · provider\u001b[0m',
    ),
    true,
  );
});

test('standalone verification assesses the downloaded quarantine state', async () => {
  const commands = [];

  await verifyQuarantinedExecution(
    '/artifact/Maka',
    '/artifact/Maka/libexec/node/bin/node',
    async (command) => {
      commands.push(command);
    },
  );

  assert.deepEqual(commands, ['xattr', 'spctl']);
});

test('standalone packaging keeps or thins arm64 Mach-O files instead of deleting them', () => {
  const macos = 'platform MACOS\n';
  assert.equal(macosArm64MachOAction('arm64', macos), 'keep');
  assert.equal(macosArm64MachOAction('x86_64 arm64', macos), 'thin');
  assert.equal(macosArm64MachOAction('x86_64', macos), 'remove');
  assert.equal(macosArm64MachOAction('arm64', 'platform IOS\n'), 'remove');
});

test('CLI signing accepts one base64 PKCS12 and one isolated Developer ID identity', () => {
  const certificate = Buffer.from('pkcs12');
  const encodedCertificate = certificate.toString('base64');
  assert.deepEqual(decodeSigningCertificate(encodedCertificate), {
    bytes: Buffer.from('pkcs12'),
  });
  assert.deepEqual(
    decodeSigningCertificate(`${encodedCertificate.slice(0, 4)}\n${encodedCertificate.slice(4)}`),
    {
      bytes: certificate,
    },
  );
  assert.throws(() => decodeSigningCertificate('not base64!'), /base64-encoded/u);
  assert.deepEqual(
    parseDeveloperIdApplicationIdentity(
      '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Maka Test (FABM2QUA8Q)"\n     1 valid identities found\n',
    ),
    {
      hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      name: 'Developer ID Application: Maka Test (FABM2QUA8Q)',
      teamIdentifier: 'FABM2QUA8Q',
    },
  );
  assert.throws(
    () =>
      parseDeveloperIdApplicationIdentity(
        '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: Test"\n',
      ),
    /one Developer ID Application/u,
  );
  assert.throws(
    () =>
      assertExpectedAppleTeam(
        { teamIdentifier: 'ABCDEFGHIJ' },
        rootManifest.releaseToolchain.appleTeamIdentifier,
      ),
    /belongs to Apple team ABCDEFGHIJ, expected FABM2QUA8Q/u,
  );
});

test('CLI signing removes temporary credentials when keychain deletion fails', async () => {
  const signing = await createSigningKeychain({
    env: { CSC_LINK: Buffer.from('pkcs12').toString('base64') },
    expectedTeamIdentifier: 'FABM2QUA8Q',
    run: async (command, args) => {
      if (command === 'openssl') {
        await writeFile(args[args.indexOf('-out') + 1], 'temporary private key');
      }
      if (command === 'security' && args[0] === 'delete-keychain') {
        throw new Error('simulated keychain deletion failure');
      }
    },
    inspect: async () => ({
      stdout:
        '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Maka Test (FABM2QUA8Q)"\n     1 valid identities found\n',
    }),
  });

  await assert.rejects(signing.cleanup(), /simulated keychain deletion failure/u);
  await assert.rejects(access(signing.directory), { code: 'ENOENT' });
});

test('CLI signing command failures do not disclose credential arguments', async () => {
  const secret = 'temporary-keychain-password';
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(9)', secret], {
      displayArgs: ['-e', '<script>', '<redacted>'],
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
      assert.match(error.message, /<redacted>/u);
      return true;
    },
  );
});

test('CLI signing removes development-only access from the official Node entitlements', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-executable-page-protection</key><true/>
<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.get-task-allow</key><true/>
</dict></plist>`;

  assert.equal(extractOfficialNodeEntitlements(`Executable=/node\n${plist}`), plist);
  const distributionPlist = distributionNodeEntitlements(plist);
  assert.deepEqual(DISTRIBUTION_NODE_RUNTIME_ENTITLEMENTS, [
    'com.apple.security.cs.allow-dyld-environment-variables',
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-executable-page-protection',
    'com.apple.security.cs.disable-library-validation',
  ]);
  assert.doesNotMatch(distributionPlist, /get-task-allow/u);
  assert.equal(extractDistributionNodeEntitlements(distributionPlist), distributionPlist);
  assert.throws(
    () =>
      extractOfficialNodeEntitlements(
        plist.replace(/<key>com\.apple\.security\.cs\.allow-jit<\/key><true\/>/u, ''),
      ),
    /entitlements do not match/u,
  );
  assert.throws(() => extractDistributionNodeEntitlements(plist), /entitlements do not match/u);
});

test('the Eval workspace owns the complete runtime asset declaration', async () => {
  const workspaces = await resolveCliWorkspacePackages();
  const evalWorkspace = workspaces.find(({ name }) => name === '@maka/eval');
  assert.ok(evalWorkspace);
  const releaseFiles = resolveWorkspaceReleaseFiles(
    evalWorkspace.directory,
    evalWorkspace.manifest,
  );
  assert.equal(releaseFiles.includes('dist'), true);
  assert.equal(
    releaseFiles.some((path) =>
      path.split('/').some((segment) => ['src', 'test', 'tests', '__tests__'].includes(segment)),
    ),
    false,
  );
});

test('standalone packaging applies the shared CLI file policy to dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-standalone-policy-'));
  try {
    await mkdir(join(root, 'test'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'test/fixture.js'), 'development');
    await writeFile(join(root, 'src/index.js'), 'runtime');
    await writeFile(join(root, 'src/index.ts'), 'development');

    await pruneThirdPartyDevelopmentArtifacts(root);

    assert.equal(await readFile(join(root, 'src/index.js'), 'utf8'), 'runtime');
    await assert.rejects(readFile(join(root, 'test/fixture.js')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, 'src/index.ts')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone workspace staging keeps runtime files and removes Maka development output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-standalone-workspace-'));
  const workspace = join(root, 'workspace');
  const install = join(root, 'install');
  try {
    await mkdir(join(workspace, 'dist', '__tests__'), { recursive: true });
    await mkdir(install);
    await writeFile(join(workspace, 'package.json'), '{}\n');
    await writeFile(join(workspace, 'dist', 'index.js'), 'runtime\n');
    await writeFile(join(workspace, 'dist', 'dev-cli.js'), 'development\n');
    await writeFile(join(workspace, 'dist', 'index.d.ts'), 'development\n');
    await writeFile(join(workspace, 'dist', 'index.js.map'), 'development\n');
    await writeFile(join(workspace, 'dist', '__tests__', 'fixture.js'), 'development\n');

    await stageWorkspacePackages(install, [
      {
        directory: workspace,
        manifest: { name: '@maka/example' },
        workspacePath: 'packages/example',
      },
    ]);

    const staged = join(install, 'packages', 'example', 'dist');
    assert.equal(await readFile(join(staged, 'index.js'), 'utf8'), 'runtime\n');
    for (const path of ['dev-cli.js', 'index.d.ts', 'index.js.map', '__tests__/fixture.js']) {
      await assert.rejects(readFile(join(staged, path)), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone dependency installation removes host script policy and unrelated workspaces', () => {
  const staged = standaloneInstallRootManifest(
    {
      private: true,
      workspaces: ['packages/cli', 'apps/desktop'],
      allowScripts: { electron: true },
      overrides: { dependency: '1.0.0' },
    },
    [{ workspacePath: 'packages/cli' }],
  );
  assert.deepEqual(staged.workspaces, ['packages/cli']);
  assert.equal(Object.hasOwn(staged, 'allowScripts'), false);
  assert.deepEqual(staged.overrides, { dependency: '1.0.0' });
});

test('standalone dependency installation ignores caller-specific npm script policy', () => {
  const environment = standaloneInstallEnvironment({
    PATH: '/usr/bin',
    npm_config_allow_scripts: '@opencode-ai/cli',
  });
  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    npm_config_userconfig: join(process.cwd(), '.npmrc'),
  });
});

test('one product workflow gates one draft release on every required artifact', async () => {
  const source = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const workflow = parseYaml(source);
  const jobs = workflow.jobs;

  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(jobs.publish.permissions.contents, 'write');
  assert.deepEqual(jobs.publish.needs, ['release-identity', 'desktop', 'cli-macos-arm64']);
  assert.equal(jobs.publish.if, undefined);
  assert.equal(Object.hasOwn(jobs, 'npm'), false);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_reference_tag.required, true);
  assert.equal(jobs['release-identity'].steps[0].with.ref, '${{ github.sha }}');
  const sourceAuthority = jobs['release-identity'].steps.find(
    (step) => step.name === 'Require the exact ASF source reference',
  ).run;
  assert.match(sourceAuthority, /RELEASE_REPOSITORY.*apache\/maka/su);
  assert.match(sourceAuthority, /refs\/tags\/\$SOURCE_REFERENCE_TAG/u);
  assert.match(sourceAuthority, /git cat-file -t/u);
  assert.match(sourceAuthority, /git rev-parse.*\^\{commit\}/u);
  assert.match(sourceAuthority, /git merge-base --is-ancestor/u);
  const liveSourceAuthority = jobs.publish.steps.find(
    (step) => step.name === 'Revalidate the live ASF source reference',
  ).run;
  assert.match(liveSourceAuthority, /git fetch --force --no-tags origin/u);
  assert.match(liveSourceAuthority, /git rev-parse.*\^\{commit\}/u);
  assert.match(liveSourceAuthority, /git merge-base --is-ancestor/u);
  assert.equal(Object.hasOwn(jobs, 'source'), false);
  for (const name of ['desktop', 'cli-macos-arm64', 'publish']) {
    const checkout = jobs[name].steps.find((step) =>
      String(step.uses).startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with.ref, '${{ needs.release-identity.outputs.source_commit }}');
  }

  const desktopStepNames = jobs.desktop.steps.map((step) => step.name);
  const uploadIndex = desktopStepNames.indexOf('Upload the verified release assets');
  assert.ok(uploadIndex >= 0);
  for (const verifier of ['Verify the final DMG', 'Verify the Windows release']) {
    const verifierIndex = desktopStepNames.indexOf(verifier);
    assert.ok(verifierIndex >= 0 && verifierIndex < uploadIndex);
  }
  for (const [jobName, group] of [
    ['desktop', 'desktop-${{ matrix.platform }}'],
    ['cli-macos-arm64', 'cli-macos-arm64'],
  ]) {
    const stage = jobs[jobName].steps.find(
      (step) => step.name === 'Stage the exact product artifact group',
    );
    assert.ok(stage.run.includes(`product-release-artifacts.mjs stage "${group}"`));
    const upload = jobs[jobName].steps.find((step) =>
      String(step.uses).startsWith('actions/upload-artifact@'),
    );
    assert.equal(upload.with.path, '${{ runner.temp }}/release-assets');
  }
  const verifyArtifacts = jobs.publish.steps.find(
    (step) => step.name === 'Verify the exact product artifact manifest',
  ).run;
  assert.match(verifyArtifacts, /product-release-artifacts\.mjs verify release-assets/u);
  assert.doesNotMatch(verifyArtifacts, /required=\(|Maka-\*|latest\*\.yml/u);

  const commands = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run) => typeof run === 'string')
    .join('\n');
  assert.equal((commands.match(/gh release create/gu) ?? []).length, 1);
  assert.equal(jobs.desktop['timeout-minutes'], 60);
  assert.match(commands, /npm run package:windows-autoupdate-next/u);
  assert.match(commands, /npm run verify:windows-autoupdate/u);
  assert.match(commands, /product-release-tag\.mjs ensure/u);
  assert.doesNotMatch(commands, /RECOVERY_SOURCE|inputs\.source_commit/u);
  assert.match(commands, /if gh release view "\$TAG"/u);
  assert.match(commands, /--json isDraft/u);
  assert.match(commands, /gh release create[\s\S]*--verify-tag/u);
  const publishRelease = jobs.publish.steps.find(
    (step) => step.name === 'Create or update the draft GitHub Release',
  ).run;
  assert.equal(
    jobs['release-identity'].outputs.is_prerelease,
    '${{ steps.identity.outputs.is_prerelease }}',
  );
  assert.equal(
    jobs.publish.steps.find((step) => step.name === 'Create or update the draft GitHub Release').env
      .IS_PRERELEASE,
    '${{ needs.release-identity.outputs.is_prerelease }}',
  );
  assert.match(publishRelease, /classification=\(--prerelease=false --latest=false\)/u);
  assert.match(publishRelease, /classification=\(--prerelease --latest=false\)/u);
  assert.doesNotMatch(publishRelease, /--latest(?:\s|\\|$)/u);
  assert.match(publishRelease, /--json isPrerelease/u);
  assert.doesNotMatch(publishRelease, /gh release delete-asset/u);
  assert.match(publishRelease, /gh release download/u);
  assert.match(publishRelease, /cmp -s/u);
  assert.match(publishRelease, /gh release upload/u);
  assert.doesNotMatch(publishRelease, /--clobber/u);
  const listAssets = publishRelease.indexOf('asset_names="$(gh release view');
  const compareAssets = publishRelease.indexOf('cmp -s');
  const uploadAssets = publishRelease.indexOf('gh release upload');
  assert.ok(listAssets >= 0 && listAssets < compareAssets && compareAssets < uploadAssets);
  assert.doesNotMatch(commands, /gh release create[\s\S]*--target/u);
  assert.doesNotMatch(commands, /cli-v|npm (?:stage )?publish/u);
});

test('repository control plane admits only reviewed immutable release tags', async () => {
  const config = parseYaml(await readFile(new URL('../.asf.yaml', import.meta.url), 'utf8'));
  const environments = config.github.environments;
  for (const [name, tagPattern] of [
    ['release', 'v*-incubating-rc*'],
    ['npm-release', 'v*'],
  ]) {
    assert.deepEqual(environments[name], {
      required_reviewers: [{ id: 'M4n5ter', type: 'User' }],
      wait_timer: 0,
      prevent_self_review: true,
      deployment_branch_policy: {
        protected_branches: false,
        policies: [{ name: tagPattern, type: 'tag' }],
      },
    });
  }
  assert.deepEqual(
    config.github.rulesets.find((ruleset) => ruleset.name === 'Immutable release tags'),
    {
      name: 'Immutable release tags',
      type: 'tag',
      branches: { includes: ['v*'], excludes: [] },
      restrict_deletion: true,
      restrict_force_push: true,
    },
  );
});
