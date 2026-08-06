import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_GIT_SOURCE_COMPONENTS,
  prepareBundledGitSourceMaterials,
} from './prepare-bundled-git-source.mjs';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('materializes commit-addressed source archives and a verifiable manifest', async () => {
  const fixture = await createFixture();
  const requested = [];
  try {
    const manifest = await prepareBundledGitSourceMaterials({
      dugiteRoot: fixture.dugiteRoot,
      outputDirectory: fixture.outputDirectory,
      fetchImpl: async (url) => {
        requested.push(url);
        return new Response(`source for ${url}\n`, { status: 200 });
      },
    });

    assert.deepEqual(
      requested,
      BUNDLED_GIT_SOURCE_COMPONENTS.map((component) => component.sourceUrl),
    );
    assert.equal(manifest.protocol, 'maka_bundled_git_source_materials_v1');
    assert.equal(manifest.dugiteVersion, '3.2.2');
    assert.equal(manifest.dugiteNativeRelease, 'v2.53.0-3');
    assert.equal(manifest.dugiteNativeCommit, 'f49d0098409aa243de8b9162127025ab0bb07a88');
    assert.equal(manifest.components.length, BUNDLED_GIT_SOURCE_COMPONENTS.length);
    for (const component of manifest.components) {
      const content = await readFile(join(fixture.outputDirectory, component.archiveFile));
      assert.equal(component.sha256, sha256(content));
      assert.equal(component.bytes, content.byteLength);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.outputDirectory, 'SOURCE_MANIFEST.json'), 'utf8')),
      manifest,
    );
    assert.match(
      await readFile(join(fixture.outputDirectory, 'README.txt'), 'utf8'),
      /not change Maka's Apache-2\.0 license/u,
    );
  } finally {
    await fixture.remove();
  }
});

test('rejects source pins that do not match the runtime archive provenance', async () => {
  const fixture = await createFixture({ release: 'v2.53.0-2', build: '8635780' });
  try {
    await assert.rejects(
      prepareBundledGitSourceMaterials({
        dugiteRoot: fixture.dugiteRoot,
        outputDirectory: fixture.outputDirectory,
        fetchImpl: async () => {
          throw new Error('must fail before network access');
        },
      }),
      /does not match source-material pins/u,
    );
  } finally {
    await fixture.remove();
  }
});

test('refuses to replace an output directory it does not own', async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.outputDirectory, { recursive: true });
    await writeFile(join(fixture.outputDirectory, 'user-file.txt'), 'keep me');
    await assert.rejects(
      prepareBundledGitSourceMaterials({
        dugiteRoot: fixture.dugiteRoot,
        outputDirectory: fixture.outputDirectory,
        fetchImpl: async (url) => new Response(`source for ${url}\n`, { status: 200 }),
      }),
      /not owned by the bundled Git source-material protocol/u,
    );
    assert.equal(await readFile(join(fixture.outputDirectory, 'user-file.txt'), 'utf8'), 'keep me');
  } finally {
    await fixture.remove();
  }
});

test('packages a written source offer and publishes source materials with every release', async () => {
  const [offer, builderConfig, verifier, workflow] = await Promise.all([
    readFile(
      join(repositoryRoot, 'apps', 'desktop', 'resources', 'licenses', 'git', 'SOURCE_OFFER.txt'),
      'utf8',
    ),
    readFile(join(repositoryRoot, 'apps', 'desktop', 'electron-builder.config.mjs'), 'utf8'),
    readFile(join(repositoryRoot, 'scripts', 'verify-packaged-app.mjs'), 'utf8'),
    readFile(join(repositoryRoot, '.github', 'workflows', 'release-desktop.yml'), 'utf8'),
  ]);

  assert.match(offer, /at least three years/u);
  assert.match(offer, /complete corresponding\s+machine-readable source/u);
  assert.match(offer, /github\.com\/maka-agent\/maka-agent\/issues\/new/u);
  assert.match(builderConfig, /resources\/licenses\/git\/SOURCE_OFFER\.txt/u);
  assert.match(verifier, /join\('licenses', 'git', 'SOURCE_OFFER\.txt'\)/u);
  assert.match(workflow, /^  source:/mu);
  assert.match(workflow, /npm run prepare:bundled-git-source/u);
  assert.match(workflow, /needs: \[build, source\]/u);
});

async function createFixture({ release = 'v2.53.0-3', build = 'f49d009' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-source-materials-'));
  const dugiteRoot = join(root, 'dugite');
  const outputDirectory = join(root, 'output');
  await mkdir(join(dugiteRoot, 'script'), { recursive: true });
  await writeFile(join(dugiteRoot, 'package.json'), '{"name":"dugite","version":"3.2.2"}\n');
  await writeFile(
    join(dugiteRoot, 'script', 'embedded-git.json'),
    `${JSON.stringify({
      'win32-x64': {
        name: `dugite-native-v2.53.0-${build}-windows-x64.tar.gz`,
        url: `https://github.com/desktop/dugite-native/releases/download/${release}/runtime.tar.gz`,
        checksum: '1'.repeat(64),
      },
      'darwin-arm64': {
        name: `dugite-native-v2.53.0-${build}-macOS-arm64.tar.gz`,
        url: `https://github.com/desktop/dugite-native/releases/download/${release}/runtime.tar.gz`,
        checksum: '2'.repeat(64),
      },
    })}\n`,
  );
  return {
    dugiteRoot,
    outputDirectory,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
