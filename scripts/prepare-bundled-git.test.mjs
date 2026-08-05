import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareBundledGit } from './prepare-bundled-git.mjs';

test('prepares from dugite provenance without assuming an archive-internal license path', async () => {
  const fixture = await createDugiteFixture();
  try {
    const manifest = await prepareBundledGit({
      dugiteRoot: fixture.dugiteRoot,
      gitLicensePath: fixture.gitLicensePath,
      outputPath: fixture.outputPath,
      platform: 'win32',
      arch: 'x64',
      runGit: async (executablePath) => {
        assert.equal(executablePath, fixture.executablePath);
        return 'git version 2.53.0.windows.1\n';
      },
    });

    assert.deepEqual(JSON.parse(await readFile(fixture.outputPath, 'utf8')), manifest);
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      protocol: 'maka_bundled_git_runtime_v1',
      provider: 'desktop/dugite-native',
      gitVersion: '2.53.0',
      platform: 'win32',
      arch: 'x64',
      executableRelativePath: 'git/cmd/git.exe',
      executableSha256: 'sha256:f391158ea86e1e56b2b0c13583821c2b752c2abccd91496d91e025d54ac616e5',
      sourceArchiveSha256:
        'sha256:f843a87a693bfdabed83b8492bca59db6f64d1168c74d23e2c8dfb7388a97142',
      distributionReady: true,
    });
  } finally {
    await fixture.remove();
  }
});

test('fails closed when dugite reports an unexpected Git version', async () => {
  const fixture = await createDugiteFixture();
  try {
    await assert.rejects(
      prepareBundledGit({
        dugiteRoot: fixture.dugiteRoot,
        gitLicensePath: fixture.gitLicensePath,
        outputPath: fixture.outputPath,
        platform: 'win32',
        arch: 'x64',
        runGit: async () => 'git version 2.52.0.windows.1\n',
      }),
      /expected Git 2\.53\.0/,
    );
  } finally {
    await fixture.remove();
  }
});

test('fails closed when the platform archive is not pinned by dugite', async () => {
  const fixture = await createDugiteFixture();
  try {
    await assert.rejects(
      prepareBundledGit({
        dugiteRoot: fixture.dugiteRoot,
        gitLicensePath: fixture.gitLicensePath,
        outputPath: fixture.outputPath,
        platform: 'freebsd',
        arch: 'x64',
        runGit: async () => 'git version 2.53.0\n',
      }),
      /does not provide a pinned Git archive/,
    );
  } finally {
    await fixture.remove();
  }
});

async function createDugiteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-prepare-dugite-'));
  const dugiteRoot = join(root, 'dugite');
  const executablePath = join(dugiteRoot, 'git', 'cmd', 'git.exe');
  const gitLicensePath = join(root, 'Git-LICENSE.txt');
  const outputPath = join(root, 'bundled-git.json');
  await mkdir(join(dugiteRoot, 'script'), { recursive: true });
  await mkdir(join(dugiteRoot, 'git', 'cmd'), { recursive: true });
  await writeFile(join(dugiteRoot, 'package.json'), '{"name":"dugite","version":"3.2.2"}\n');
  await writeFile(join(dugiteRoot, 'LICENSE'), 'MIT fixture license\n');
  await writeFile(gitLicensePath, 'GPLv2 fixture license\n');
  await writeFile(executablePath, 'fake bundled git\n');
  await writeFile(
    join(dugiteRoot, 'script', 'embedded-git.json'),
    `${JSON.stringify({
      'win32-x64': {
        name: 'dugite-native-v2.53.0-f49d009-windows-x64.tar.gz',
        url: 'https://github.com/desktop/dugite-native/releases/download/v2.53.0-3/archive.tar.gz',
        checksum: 'f843a87a693bfdabed83b8492bca59db6f64d1168c74d23e2c8dfb7388a97142',
      },
    })}\n`,
  );
  return {
    dugiteRoot,
    executablePath,
    gitLicensePath,
    outputPath,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
