import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertPublicVersionVacant,
  fetchRegistryRelease,
  parseCliReleaseVersion,
  prepareStageRelease,
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

test('staging refuses an existing public version and fails closed on registry errors', async () => {
  await assert.doesNotReject(
    assertPublicVersionVacant({
      version: '0.1.0-beta.1',
      fetchImpl: async () => new Response('not found', { status: 404 }),
    }),
  );
  await assert.rejects(
    assertPublicVersionVacant({
      version: '0.1.0-beta.1',
      fetchImpl: async () => Response.json({ name: 'maka-agent', version: '0.1.0-beta.1' }),
    }),
    /already exists/u,
  );
  await assert.rejects(
    assertPublicVersionVacant({
      version: '0.1.0-beta.1',
      fetchImpl: async () => new Response('unavailable', { status: 503 }),
    }),
    /status 503/u,
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
  const fetchImpl = async (input) => {
    if (String(input) !== tarballUrl) return fallback(input);
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
  return async (input) => {
    const url = String(input);
    if (url === `https://registry.npmjs.org/maka-agent/${fixture.version}`) {
      return Response.json({
        name: 'maka-agent',
        version: fixture.version,
        dist: { tarball: tarballUrl, integrity, shasum },
      });
    }
    if (url === 'https://registry.npmjs.org/maka-agent') {
      return Response.json({ 'dist-tags': { next: fixture.version } });
    }
    if (url === tarballUrl) return new Response(bytes);
    return new Response('not found', { status: 404 });
  };
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
