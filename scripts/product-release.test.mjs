import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { parseCliReleaseVersion } from './release-cli-publication.mjs';
import { planTests } from './ci-test-plan.mjs';
import {
  assertProductReleaseExpectation,
  releaseToolchainFromManifest,
  resolveProductReleaseIdentity,
} from './product-release-identity.mjs';
import {
  decodeSigningCertificate,
  macosArm64CliWrapper,
  macosArm64MachOAction,
  parseDeveloperIdApplicationIdentity,
  pruneThirdPartyDevelopmentArtifacts,
  resolveCliWorkspacePackages,
  resolveMacosArm64CliArtifactPaths,
  stageWorkspacePackages,
  standaloneInstallEnvironment,
  standaloneInstallRootManifest,
} from './package-macos-arm64-cli.mjs';
import { workspaceReleaseFiles } from './release-cli-file-policy.mjs';
import { isTuiReadyOutput } from './verify-macos-arm64-cli.mjs';
import { ensureProductTag } from './product-release-tag.mjs';

const execFileAsync = promisify(execFile);

const rootManifest = {
  version: '1.2.3',
  packageManager: 'npm@11.19.0',
  releaseToolchain: {
    node: '24.18.1',
    nodeDarwinArm64Sha256: '1'.repeat(64),
  },
};

test('one root version defines every product artifact from one main commit', () => {
  const identity = resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest: { version: '1.2.3' },
    cliManifest: { version: '1.2.3', bin: { maka: './dist/cli.js' } },
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
  });

  assert.equal(identity.version, '1.2.3');
  assert.equal(identity.tag, 'v1.2.3');
  assert.equal(identity.sourceCommit, 'a'.repeat(40));
  assert.equal(identity.dmg, 'Maka-1.2.3-mac-arm64.dmg');
  assert.equal(identity.exe, 'Maka-1.2.3-win-x64.exe');
  assert.equal(identity.cliArchive, 'Maka-1.2.3-cli-mac-arm64.zip');
  assert.equal(identity.sourceArchive, 'Maka-1.2.3-bundled-git-source.tar.gz');
});

test('an npm candidate must name the exact product tag, version, and source commit', () => {
  const identity = resolveProductReleaseIdentity({
    rootManifest,
    desktopManifest: { version: '1.2.3' },
    cliManifest: { version: '1.2.3', bin: { maka: './dist/cli.js' } },
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
  });

  assert.doesNotThrow(() =>
    assertProductReleaseExpectation(identity, {
      version: '1.2.3',
      tag: 'v1.2.3',
      sourceCommit: 'a'.repeat(40),
    }),
  );
  for (const expected of [
    { version: '1.2.4', tag: 'v1.2.3', sourceCommit: 'a'.repeat(40) },
    { version: '1.2.3', tag: 'v1.2.4', sourceCommit: 'a'.repeat(40) },
    { version: '1.2.3', tag: 'v1.2.3', sourceCommit: 'b'.repeat(40) },
  ]) {
    assert.throws(
      () => assertProductReleaseExpectation(identity, expected),
      /does not match product release/u,
    );
  }
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

test('the root manifest pins the Node archive and npm used by release jobs', () => {
  assert.deepEqual(releaseToolchainFromManifest(rootManifest), {
    nodeVersion: '24.18.1',
    nodeArchive: 'node-v24.18.1-darwin-arm64.tar.xz',
    nodeArchiveSha256: '1'.repeat(64),
    nodeSourceUrl: 'https://nodejs.org/download/release/v24.18.1/node-v24.18.1-darwin-arm64.tar.xz',
    npmVersion: '11.19.0',
  });
});

test('standalone verification recognizes the current TUI status line through ANSI output', () => {
  assert.equal(
    isTuiReadyOutput(
      '\u001b[1mMaka\u001b[22m\u001b[2m · \u001b[22m\u001b[2mAuto\u001b[22m\u001b[2m · model · provider\u001b[0m',
    ),
    true,
  );
});

test('standalone packaging keeps or thins arm64 Mach-O files instead of deleting them', () => {
  const macos = 'platform MACOS\n';
  assert.equal(macosArm64MachOAction('arm64', macos), 'keep');
  assert.equal(macosArm64MachOAction('x86_64 arm64', macos), 'thin');
  assert.equal(macosArm64MachOAction('x86_64', macos), 'remove');
  assert.equal(macosArm64MachOAction('arm64', 'platform IOS\n'), 'reject');
});

test('CLI signing accepts one base64 PKCS12 and one isolated Developer ID identity', () => {
  assert.deepEqual(decodeSigningCertificate(Buffer.from('pkcs12').toString('base64')), {
    bytes: Buffer.from('pkcs12'),
  });
  assert.throws(() => decodeSigningCertificate('not base64!'), /base64-encoded/u);
  assert.deepEqual(
    parseDeveloperIdApplicationIdentity(
      '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Developer ID Application: Maka Test (TEAMID)"\n     1 valid identities found\n',
    ),
    {
      hash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      name: 'Developer ID Application: Maka Test (TEAMID)',
    },
  );
  assert.throws(
    () =>
      parseDeveloperIdApplicationIdentity(
        '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: Test"\n',
      ),
    /one Developer ID Application/u,
  );
});

test('the standalone maka launcher is relocatable and uses the embedded runtime', () => {
  const paths = resolveMacosArm64CliArtifactPaths('1.2.3');
  assert.equal(paths.archiveRootName, 'Maka-1.2.3-cli-mac-arm64');
  assert.equal(paths.archivePath.endsWith('Maka-1.2.3-cli-mac-arm64.zip'), true);

  const wrapper = macosArm64CliWrapper();
  assert.match(wrapper, /while \[ -L "\$launcher" \]/u);
  assert.match(wrapper, /libexec\/node\/bin\/node/u);
  assert.match(wrapper, /libexec\/node_modules\/maka-agent\/dist\/cli\.js/u);
});

test('the Eval workspace owns the complete runtime asset declaration', async () => {
  const workspaces = await resolveCliWorkspacePackages();
  const evalWorkspace = workspaces.find(({ name }) => name === '@maka/eval');
  assert.ok(evalWorkspace);
  assert.deepEqual(workspaceReleaseFiles(evalWorkspace.manifest), [
    'dist',
    'harbor/deepseek-codex-models.json',
    'harbor/deepseek-harness-profile/cordis.patch.yml',
    'harbor/deepseek-harness-profile/cordis.yml',
    'harbor/deepseek-harness-profile/package.json',
    'harbor/docker-compose-egress-proxy.yaml',
    'harbor/egress-proxy/Dockerfile',
    'harbor/egress-proxy/entrypoint.sh',
    'harbor/egress-proxy/network-policy',
    'harbor/egress_filter.py',
    'harbor/eval_framework.py',
    'harbor/relay_agent.py',
    'harbor/run_trial.py',
  ]);
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
  assert.deepEqual(jobs.publish.needs, [
    'release-identity',
    'desktop',
    'cli-macos-arm64',
    'source',
  ]);
  assert.equal(jobs.publish.if, "github.ref == 'refs/heads/main'");
  assert.equal(Object.hasOwn(jobs, 'npm'), false);
  assert.equal(
    jobs['release-identity'].steps[0].with.ref,
    '${{ inputs.source_commit || github.sha }}',
  );
  for (const name of ['desktop', 'cli-macos-arm64', 'source', 'publish']) {
    const checkout = jobs[name].steps.find((step) =>
      String(step.uses).startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with.ref, '${{ needs.release-identity.outputs.source_commit }}');
  }

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
  assert.match(commands, /RECOVERY_SOURCE/u);
  assert.match(commands, /--json isDraft/u);
  assert.match(commands, /gh release create[\s\S]*--verify-tag/u);
  assert.match(commands, /gh release upload[\s\S]*--clobber/u);
  assert.doesNotMatch(commands, /gh release create[\s\S]*--target/u);
  assert.doesNotMatch(commands, /cli-v|npm (?:stage )?publish/u);
  await assert.rejects(
    readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url)),
    { code: 'ENOENT' },
  );
});

test('npm channel identity has no independent product tag', () => {
  assert.deepEqual(parseCliReleaseVersion('1.2.3'), {
    version: '1.2.3',
    distTag: 'latest',
    tarball: 'maka-agent-1.2.3.tgz',
  });
});

test('product workflow changes select the release contracts in CI', () => {
  const graph = {
    dirs: [],
    testDirs: new Set(),
    dependents: new Map(),
  };
  const plan = planTests(['.github/workflows/release.yml'], { graph });
  assert.equal(plan.code, true);
  assert.equal(plan.full, false);
  assert.equal(plan.e2e, false);
  assert.equal(plan.storybook, false);
  assert.deepEqual(plan.workspaces, []);
});
