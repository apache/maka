import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveBundledGitRuntime } from '../server/bundled-git-runtime.js';

test('resolves the packaged Git executable from a strict platform manifest', async () => {
  const fixture = await createFixture();
  try {
    const canonicalRoot = await realpath(fixture.root);
    assert.deepEqual(
      await resolveBundledGitRuntime({
        resourcesRoot: fixture.root,
        platform: 'win32',
        arch: 'x64',
      }),
      {
        executablePath: await realpath(fixture.executablePath),
        expectedSha256: 'sha256:f391158ea86e1e56b2b0c13583821c2b752c2abccd91496d91e025d54ac616e5',
        runtimeIdentitySha256:
          'sha256:926a45a8cd95c8ae25683905dc9171c54a9e31ffe362875c8f8b7f6e67ed522f',
        distribution: {
          kind: 'dugite_native_v1',
          rootPath: join(canonicalRoot, 'git'),
        },
      },
    );
  } finally {
    await fixture.remove();
  }
});

test('fails closed when the bundled Git platform does not match the host', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      resolveBundledGitRuntime({
        resourcesRoot: fixture.root,
        platform: 'darwin',
        arch: 'arm64',
      }),
      { code: 'bundled_git_platform_mismatch' },
    );
  } finally {
    await fixture.remove();
  }
});

test('binds runtime identity to the complete source archive provenance', async () => {
  const first = await createFixture();
  const second = await createFixture({
    sourceArchiveSha256: `sha256:${'2'.repeat(64)}`,
  });
  try {
    const firstRuntime = await resolveBundledGitRuntime({
      resourcesRoot: first.root,
      platform: 'win32',
      arch: 'x64',
    });
    const secondRuntime = await resolveBundledGitRuntime({
      resourcesRoot: second.root,
      platform: 'win32',
      arch: 'x64',
    });
    assert.equal(firstRuntime.expectedSha256, secondRuntime.expectedSha256);
    assert.notEqual(firstRuntime.runtimeIdentitySha256, secondRuntime.runtimeIdentitySha256);
  } finally {
    await Promise.all([first.remove(), second.remove()]);
  }
});

test('fails closed when the packaged Git executable does not match its manifest', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.executablePath, 'tampered bundled git\n');
    await assert.rejects(
      resolveBundledGitRuntime({
        resourcesRoot: fixture.root,
        platform: 'win32',
        arch: 'x64',
      }),
      { code: 'bundled_git_integrity_mismatch' },
    );
  } finally {
    await fixture.remove();
  }
});

test('does not fall back to PATH when the bundled Git manifest is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-git-missing-'));
  try {
    await assert.rejects(
      resolveBundledGitRuntime({ resourcesRoot: root, platform: 'win32', arch: 'x64' }),
      { code: 'bundled_git_unavailable' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects manifest fields that could redirect execution outside resources', async () => {
  const fixture = await createFixture({ executableRelativePath: '../system/git.exe' });
  try {
    await assert.rejects(
      resolveBundledGitRuntime({
        resourcesRoot: fixture.root,
        platform: 'win32',
        arch: 'x64',
      }),
      { code: 'bundled_git_manifest_invalid' },
    );
  } finally {
    await fixture.remove();
  }
});

const executableSha256 = 'sha256:f391158ea86e1e56b2b0c13583821c2b752c2abccd91496d91e025d54ac616e5';

async function createFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-git-'));
  const executablePath = join(root, 'git', 'cmd', 'git.exe');
  await mkdir(join(root, 'git', 'cmd'), { recursive: true });
  await writeFile(executablePath, 'fake bundled git\n');
  await writeFile(
    join(root, 'bundled-git.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_git_runtime_v1',
      provider: 'desktop/dugite-native',
      gitVersion: '2.53.0',
      platform: 'win32',
      arch: 'x64',
      executableRelativePath: 'git/cmd/git.exe',
      executableSha256,
      sourceArchiveSha256:
        'sha256:f843a87a693bfdabed83b8492bca59db6f64d1168c74d23e2c8dfb7388a97142',
      distributionReady: true,
      ...overrides,
    })}\n`,
  );
  return {
    root,
    executablePath,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
