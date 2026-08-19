import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { resolveRuntimeHostCliInstallationContext } from '../runtime-host-installation-context.js';

test('published CLI package version is its stable Runtime Host artifact generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-release-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestUrl = pathToFileURL(join(root, 'package.json'));
  await writeFile(manifestUrl, JSON.stringify({ name: 'maka-agent', version: '1.2.3' }));

  const context = await resolveRuntimeHostCliInstallationContext({
    manifestUrl,
  });

  assert.deepEqual(context, {
    packageRoot: fileURLToPath(new URL('.', manifestUrl)),
    version: '1.2.3',
    installationScope: 'persistent',
    artifactGeneration: 'maka-agent@1.2.3',
  });
});

test('development CLI process receives a distinct explicit artifact generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-development-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestUrl = pathToFileURL(join(root, 'package.json'));
  await writeFile(
    manifestUrl,
    JSON.stringify({ name: 'maka-agent', version: '1.2.3', private: true }),
  );

  const context = await resolveRuntimeHostCliInstallationContext({
    manifestUrl,
    developmentId: 'dev-process',
  });

  assert.equal(context.packageRoot, fileURLToPath(new URL('.', manifestUrl)));
  assert.equal(context.version, '1.2.3');
  assert.equal(context.installationScope, 'persistent');
  assert.equal(context.artifactGeneration, 'maka-agent@1.2.3+development.dev-process');
});

test('temporary npx package can identify a candidate but cannot replace a persistent Host', async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'maka-cli-npx-context-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const packageRoot = join(cacheRoot, '_npx', 'hash', 'node_modules', 'maka-agent');
  await mkdir(packageRoot, { recursive: true });
  const manifestUrl = pathToFileURL(join(packageRoot, 'package.json'));
  await writeFile(manifestUrl, JSON.stringify({ name: 'maka-agent', version: '1.2.3' }));

  const context = await resolveRuntimeHostCliInstallationContext({
    manifestUrl,
    environment: { npm_config_cache: cacheRoot },
    homeDir: join(cacheRoot, 'home'),
  });

  assert.equal(context.installationScope, 'temporary_npx');
  assert.equal(context.artifactGeneration, 'maka-agent@1.2.3');
});

test('CLI installation context rejects a different package manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-invalid-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestUrl = pathToFileURL(join(root, 'package.json'));
  await writeFile(manifestUrl, JSON.stringify({ name: 'not-maka', version: '1.2.3' }));

  await assert.rejects(
    resolveRuntimeHostCliInstallationContext({ manifestUrl }),
    /installation manifest is invalid/,
  );
});
