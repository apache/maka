import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  fetchRegistryRelease,
  parseCliReleaseVersion,
  prepareSignatureAuditTree,
  prepareStageRelease,
  validateGitHubRelease,
  validateRegistryChannels,
  validateSignatureAudit,
  validateStageRun,
} from './release-cli-publication.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const WORKFLOW_PATH = '.github/workflows/release-cli-stage.yml';

test('release versions map prereleases and stable versions to distinct channels', () => {
  assert.deepEqual(parseCliReleaseVersion('0.1.0-beta.1'), {
    version: '0.1.0-beta.1',
    distTag: 'next',
    gitTag: 'cli-v0.1.0-beta.1',
    tarball: 'maka-agent-0.1.0-beta.1.tgz',
  });
  assert.equal(parseCliReleaseVersion('0.1.0').distTag, 'latest');
  for (const version of ['01.0.0', '0.1', '0.1.0+local', '0.1.0-beta..1', '../0.1.0']) {
    assert.throws(() => parseCliReleaseVersion(version), /valid CLI release version/u);
  }
});

test('release channels never leave next behind latest', () => {
  for (const next of ['0.1.0', '0.2.0-beta.1']) {
    assert.doesNotThrow(() =>
      validateRegistryChannels({
        releaseVersion: '0.1.0',
        releaseDistTag: 'latest',
        distTags: { latest: '0.1.0', next },
      }),
    );
  }

  for (const next of [undefined, '0.1.0-beta.1']) {
    assert.throws(
      () =>
        validateRegistryChannels({
          releaseVersion: '0.1.0',
          releaseDistTag: 'latest',
          distTags: { latest: '0.1.0', ...(next ? { next } : {}) },
        }),
      /npm dist-tag add "maka-agent@0\.1\.0" next/u,
    );
  }

  assert.doesNotThrow(() =>
    validateRegistryChannels({
      releaseVersion: '0.2.0-beta.1',
      releaseDistTag: 'next',
      distTags: { latest: '0.1.0', next: '0.2.0-beta.1' },
    }),
  );
  assert.throws(
    () =>
      validateRegistryChannels({
        releaseVersion: '0.1.0-beta.2',
        releaseDistTag: 'next',
        distTags: { latest: '0.1.0', next: '0.1.0-beta.2' },
      }),
    /cannot advance the next channel/u,
  );
});

test('stage records bind the checked candidate to one source workflow run', () => {
  const fixture = createCandidate();
  const prepared = prepareStageRelease({
    repoRoot: fixture.root,
    releaseDirectory: fixture.releaseDirectory,
    expectedVersion: fixture.version,
    sourceSha: SOURCE_SHA,
    runId: '321',
    runAttempt: '1',
    repository: 'maka-agent/maka-agent',
    workflowPath: WORKFLOW_PATH,
  });

  assert.equal(prepared.record.sha256, fixture.sha256);
  assert.equal(prepared.record.source.commit, SOURCE_SHA);
  assert.equal(prepared.record.source.runId, '321');
  assert.equal(prepared.record.source.runAttempt, '1');
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture.releaseDirectory, 'release.json'), 'utf8')),
    prepared.record,
  );
});

test('stage preparation rejects confirmation and checksum drift', () => {
  const fixture = createCandidate();
  assert.throws(
    () =>
      prepareStageRelease({
        repoRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
        expectedVersion: '0.1.0-beta.2',
        sourceSha: SOURCE_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'maka-agent/maka-agent',
        workflowPath: WORKFLOW_PATH,
      }),
    /confirmation/u,
  );

  writeFileSync(`${fixture.tarballPath}.sha256`, `${'0'.repeat(64)}  ${fixture.tarball}\n`);
  assert.throws(
    () =>
      prepareStageRelease({
        repoRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
        expectedVersion: fixture.version,
        sourceSha: SOURCE_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'maka-agent/maka-agent',
        workflowPath: WORKFLOW_PATH,
      }),
    /checksum does not match/u,
  );
});

test('finalization accepts only the exact successful main stage run', () => {
  const fixture = createPreparedCandidate();
  const run = {
    id: 321,
    run_attempt: 1,
    path: WORKFLOW_PATH,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: SOURCE_SHA,
    conclusion: 'success',
    head_repository: { full_name: 'maka-agent/maka-agent' },
  };

  assert.equal(
    validateStageRun({
      releaseDirectory: fixture.releaseDirectory,
      expectedVersion: fixture.version,
      run,
    }).source.commit,
    SOURCE_SHA,
  );

  for (const drift of [
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { head_sha: 'b'.repeat(40) },
    { run_attempt: 2 },
  ]) {
    assert.throws(
      () =>
        validateStageRun({
          releaseDirectory: fixture.releaseDirectory,
          expectedVersion: fixture.version,
          run: { ...run, ...drift },
        }),
      /stage workflow run/u,
    );
  }
});

test('registry finalization requires the exact staged bytes and dist-tag', async () => {
  const fixture = createPreparedCandidate();
  const registryDirectory = mkdtempSync(join(tmpdir(), 'maka-cli-registry-release-'));
  const fetchImpl = registryFetch({ fixture });

  const result = await fetchRegistryRelease({
    releaseDirectory: fixture.releaseDirectory,
    registryDirectory,
    fetchImpl,
  });

  assert.equal(result.sha256, fixture.sha256);
  assert.deepEqual(readFileSync(result.tarballPath), fixture.bytes);
  assert.deepEqual(
    readFileSync(`${result.tarballPath}.files.json`),
    readFileSync(`${fixture.tarballPath}.files.json`),
  );
  assert.match(
    readFileSync(join(registryDirectory, 'release-notes.md'), 'utf8'),
    /Stage workflow run: .* \(attempt 1\)/u,
  );

  await assert.rejects(
    fetchRegistryRelease({
      releaseDirectory: fixture.releaseDirectory,
      registryDirectory: mkdtempSync(join(tmpdir(), 'maka-cli-registry-drift-')),
      fetchImpl: registryFetch({ fixture, bytes: Buffer.from('different release') }),
    }),
    /Registry tarball does not match/u,
  );
});

test('registry downloads stop reading as soon as the tarball exceeds its bound', async () => {
  const fixture = createPreparedCandidate();
  const fallback = registryFetch({ fixture });
  const tarballUrl = `https://registry.npmjs.org/maka-agent/-/${fixture.tarball}`;
  let pulls = 0;
  const fetchImpl = async (input, options) => {
    if (String(input) !== tarballUrl) return fallback(input, options);
    return new Response(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > 30) return controller.close();
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
    );
  };

  await assert.rejects(
    fetchRegistryRelease({
      releaseDirectory: fixture.releaseDirectory,
      registryDirectory: mkdtempSync(join(tmpdir(), 'maka-cli-registry-oversized-')),
      fetchImpl,
    }),
    /exceeds the reviewed compressed size limit/u,
  );
  assert.ok(pulls < 30, `expected an early bounded read, consumed ${pulls} chunks`);
});

test('signature audit must contain Maka provenance for the finalized version', () => {
  const fixture = createPreparedCandidate();
  const verified = {
    invalid: [],
    missing: [],
    verified: [
      {
        name: 'maka-agent',
        version: fixture.version,
        attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateSignatureAudit({
      releaseDirectory: fixture.releaseDirectory,
      audit: verified,
    }),
  );
  assert.throws(
    () =>
      validateSignatureAudit({
        releaseDirectory: fixture.releaseDirectory,
        audit: { ...verified, verified: [] },
      }),
    /verified provenance/u,
  );
  assert.throws(
    () =>
      validateSignatureAudit({
        releaseDirectory: fixture.releaseDirectory,
        audit: { ...verified, invalid: [{ name: 'dependency' }] },
      }),
    /invalid or missing signatures/u,
  );
});

test('signature audit tree exposes only the top-level registry package', () => {
  const fixture = createPreparedCandidate();
  const auditDirectory = mkdtempSync(join(tmpdir(), 'maka-cli-signature-audit-'));

  prepareSignatureAuditTree({
    releaseDirectory: fixture.releaseDirectory,
    auditDirectory,
  });

  assert.deepEqual(JSON.parse(readFileSync(join(auditDirectory, 'package.json'), 'utf8')), {
    name: 'maka-cli-signature-audit',
    private: true,
    dependencies: { 'maka-agent': fixture.version },
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(auditDirectory, 'node_modules/maka-agent/package.json'), 'utf8')),
    { name: 'maka-agent', version: fixture.version },
  );
});

test('GitHub finalization accepts only the exact published metadata and asset digests', async () => {
  const fixture = createPreparedCandidate();
  const registryDirectory = mkdtempSync(join(tmpdir(), 'maka-cli-github-release-'));
  await fetchRegistryRelease({
    releaseDirectory: fixture.releaseDirectory,
    registryDirectory,
    fetchImpl: registryFetch({ fixture }),
  });
  const release = createGitHubReleaseFixture(fixture, registryDirectory);

  assert.doesNotThrow(() =>
    validateGitHubRelease({ releaseDirectory: registryDirectory, release }),
  );
  assert.throws(
    () =>
      validateGitHubRelease({
        releaseDirectory: registryDirectory,
        release: { ...release, draft: true },
      }),
    /metadata does not match/u,
  );
  assert.throws(
    () =>
      validateGitHubRelease({
        releaseDirectory: registryDirectory,
        release: {
          ...release,
          assets: release.assets.map((asset, index) =>
            index === 0 ? { ...asset, digest: `sha256:${'0'.repeat(64)}` } : asset,
          ),
        },
      }),
    /asset does not match/u,
  );
});

test('prepare-stage CLI emits only consumed GitHub Actions outputs', () => {
  const fixture = createCandidate();
  const output = join(fixture.root, 'github-output.txt');
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'release-cli-publication.mjs'),
      'prepare-stage',
      fixture.releaseDirectory,
      fixture.version,
      SOURCE_SHA,
      '321',
      '1',
      'maka-agent/maka-agent',
      WORKFLOW_PATH,
      output,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
    `version=${fixture.version}`,
    'dist_tag=next',
    `git_tag=cli-v${fixture.version}`,
    `tarball=${fixture.tarballPath}`,
  ]);
});

test('validate-stage-run CLI emits the canonical cross-job release identity', () => {
  const fixture = createPreparedCandidate();
  const runPath = join(fixture.root, 'stage-run.json');
  const output = join(fixture.root, 'github-output.txt');
  writeFileSync(
    runPath,
    JSON.stringify({
      id: 321,
      run_attempt: 1,
      path: WORKFLOW_PATH,
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: SOURCE_SHA,
      conclusion: 'success',
      head_repository: { full_name: 'maka-agent/maka-agent' },
    }),
  );

  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'release-cli-publication.mjs'),
      'validate-stage-run',
      fixture.releaseDirectory,
      runPath,
      fixture.version,
      output,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
    `version=${fixture.version}`,
    'dist_tag=next',
    `git_tag=cli-v${fixture.version}`,
    `source_sha=${SOURCE_SHA}`,
    `tarball=${fixture.tarball}`,
  ]);
});

function createPreparedCandidate() {
  const fixture = createCandidate();
  prepareStageRelease({
    repoRoot: fixture.root,
    releaseDirectory: fixture.releaseDirectory,
    expectedVersion: fixture.version,
    sourceSha: SOURCE_SHA,
    runId: '321',
    runAttempt: '1',
    repository: 'maka-agent/maka-agent',
    workflowPath: WORKFLOW_PATH,
  });
  return fixture;
}

function createCandidate() {
  const root = mkdtempSync(join(tmpdir(), 'maka-cli-publication-'));
  const releaseDirectory = join(root, 'packages/cli/release');
  const version = '0.1.0-beta.1';
  const tarball = `maka-agent-${version}.tgz`;
  const tarballPath = join(releaseDirectory, tarball);
  const bytes = Buffer.from('immutable cli tarball');
  const sha256 = digest('sha256', bytes, 'hex');
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@11.19.0"}\n');
  writeFileSync(
    join(root, 'packages/cli/package.json'),
    `${JSON.stringify({ name: 'maka-agent', version })}\n`,
  );
  writeFileSync(tarballPath, bytes);
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${tarball}\n`);
  writeFileSync(`${tarballPath}.files.json`, '[{"path":"dist/cli.js","size":1}]\n');
  return { root, releaseDirectory, version, tarball, tarballPath, bytes, sha256 };
}

function registryFetch({ fixture, bytes = fixture.bytes }) {
  const integrity = `sha512-${digest('sha512', bytes, 'base64')}`;
  const shasum = digest('sha1', bytes, 'hex');
  const tarballUrl = `https://registry.npmjs.org/maka-agent/-/${fixture.tarball}`;
  return async (input, options = {}) => {
    const url = String(input);
    if (url === `https://registry.npmjs.org/maka-agent/${fixture.version}`) {
      assert.equal(options.headers?.accept, 'application/json');
      return Response.json({
        name: 'maka-agent',
        version: fixture.version,
        dist: { tarball: tarballUrl, integrity, shasum },
      });
    }
    if (url === 'https://registry.npmjs.org/maka-agent') {
      assert.equal(options.headers?.accept, 'application/vnd.npm.install-v1+json');
      return Response.json({ 'dist-tags': { next: fixture.version } });
    }
    if (url === tarballUrl) return new Response(bytes);
    return new Response('not found', { status: 404 });
  };
}

function createGitHubReleaseFixture(fixture, releaseDirectory) {
  const names = [
    fixture.tarball,
    `${fixture.tarball}.sha256`,
    `${fixture.tarball}.files.json`,
    'release.json',
  ];
  return {
    tag_name: `cli-v${fixture.version}`,
    name: `Maka CLI ${fixture.version}`,
    body: readFileSync(join(releaseDirectory, 'release-notes.md'), 'utf8'),
    draft: false,
    prerelease: true,
    assets: names.map((name) => {
      const bytes = readFileSync(join(releaseDirectory, name));
      return {
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: `sha256:${digest('sha256', bytes, 'hex')}`,
      };
    }),
  };
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
