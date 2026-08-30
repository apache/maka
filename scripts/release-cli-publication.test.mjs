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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CLI_RELEASE_ARTIFACT_LIMITS } from './release-cli-artifact-policy.mjs';
import {
  fetchRegistryRelease,
  parseCliNightlyVersion,
  parseCliReleaseVersion,
  prepareNightlyRelease,
  prepareSignatureAuditTree,
  prepareStageRelease,
  validateRegistryChannels,
  validateSignatureAudit,
  validateStageRun,
} from './release-cli-publication.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const PUBLISHER_SHA = 'b'.repeat(40);
const WORKFLOW_PATH = '.github/workflows/npm-publication.yml';
const CURRENT_CLI_VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../packages/cli/package.json'), 'utf8'),
).version;
const PRODUCT_TAG = 'v0.2.0';
const STAGE_RUN = {
  id: 321,
  run_attempt: 1,
  path: WORKFLOW_PATH,
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: PUBLISHER_SHA,
  conclusion: 'success',
  head_repository: { full_name: 'apache/maka' },
};

test('formal and Nightly versions map to their only public channels', () => {
  assert.deepEqual(parseCliReleaseVersion('0.2.0'), {
    version: '0.2.0',
    distTag: 'latest',
    tarball: 'maka-agent-0.2.0.tgz',
  });
  assert.deepEqual(parseCliNightlyVersion('0.2.0-dev.42.20260829', '0.2.0'), {
    version: '0.2.0-dev.42.20260829',
    distTag: 'nightly',
    tarball: 'maka-agent-0.2.0-dev.42.20260829.tgz',
  });
  assert.throws(() => parseCliReleaseVersion('0.2.0-beta.1'), /must use a stable/u);
  assert.throws(
    () => parseCliNightlyVersion('0.2.0-beta.1', '0.2.0'),
    /valid Product Nightly version/u,
  );
  for (const version of ['01.0.0', '0.1', '0.1.0+local', '0.1.0-beta..1', '../0.1.0']) {
    assert.throws(() => parseCliReleaseVersion(version), /valid product release version/u);
  }
});

test('formal finalization requires only the exact latest channel', () => {
  assert.doesNotThrow(() =>
    validateRegistryChannels({
      releaseVersion: '0.2.0',
      releaseDistTag: 'latest',
      distTags: { latest: '0.2.0', nightly: '0.3.0-dev.42.20260829' },
    }),
  );
  assert.throws(
    () =>
      validateRegistryChannels({
        releaseVersion: '0.2.0',
        releaseDistTag: 'latest',
        distTags: { latest: '0.1.0' },
      }),
    /does not point to 0\.2\.0/u,
  );
});

test('Nightly preparation validates only the exact dev candidate', () => {
  const fixture = createCandidate('0.2.0-dev.42.20260829', '0.2.0');
  const prepared = prepareNightlyRelease({
    repoRoot: fixture.root,
    releaseDirectory: fixture.releaseDirectory,
    expectedVersion: fixture.version,
  });
  assert.equal(prepared.distTag, 'nightly');
  assert.equal(prepared.tarballPath, fixture.tarballPath);
  assert.equal(prepared.sha256, fixture.sha256);
});

test('stage records bind the checked candidate to one source workflow run', () => {
  const fixture = createCandidate();
  const prepared = prepareStageRelease({
    repoRoot: fixture.root,
    releaseDirectory: fixture.releaseDirectory,
    expectedVersion: fixture.version,
    productTag: PRODUCT_TAG,
    sourceSha: SOURCE_SHA,
    publisherSha: PUBLISHER_SHA,
    runId: '321',
    runAttempt: '1',
    repository: 'apache/maka',
    workflowPath: WORKFLOW_PATH,
  });

  assert.equal(prepared.record.sha256, fixture.sha256);
  assert.equal(prepared.record.schemaVersion, 4);
  assert.equal(prepared.record.productTag, PRODUCT_TAG);
  assert.equal(prepared.record.source.commit, SOURCE_SHA);
  assert.equal(prepared.record.publisher.commit, PUBLISHER_SHA);
  assert.equal(prepared.record.publisher.runId, '321');
  assert.equal(prepared.record.publisher.runAttempt, '1');
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture.releaseDirectory, 'release.json'), 'utf8')),
    prepared.record,
  );
});

test('stage preparation rejects a product tag that does not match the version', () => {
  const fixture = createCandidate();
  assert.throws(
    () =>
      prepareStageRelease({
        repoRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
        expectedVersion: fixture.version,
        productTag: 'v9.9.9',
        sourceSha: SOURCE_SHA,
        publisherSha: PUBLISHER_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'apache/maka',
        workflowPath: WORKFLOW_PATH,
      }),
    /Product tag .* does not match/u,
  );
});

test('stage preparation rejects checksum drift', () => {
  const fixture = createCandidate();
  writeFileSync(`${fixture.tarballPath}.sha256`, `${'0'.repeat(64)}  ${fixture.tarball}\n`);
  assert.throws(
    () =>
      prepareStageRelease({
        repoRoot: fixture.root,
        releaseDirectory: fixture.releaseDirectory,
        expectedVersion: fixture.version,
        productTag: PRODUCT_TAG,
        sourceSha: SOURCE_SHA,
        publisherSha: PUBLISHER_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'apache/maka',
        workflowPath: WORKFLOW_PATH,
      }),
    /checksum does not match/u,
  );
});

test('finalization accepts only the exact successful main-branch stage run', () => {
  const fixture = createPreparedCandidate();

  assert.equal(
    validateStageRun({
      releaseDirectory: fixture.releaseDirectory,
      expectedVersion: fixture.version,
      run: STAGE_RUN,
    }).source.commit,
    SOURCE_SHA,
  );

  for (const drift of [
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_branch: 'other' },
    { conclusion: 'failure' },
    { head_sha: 'c'.repeat(40) },
    { run_attempt: 2 },
  ]) {
    assert.throws(
      () =>
        validateStageRun({
          releaseDirectory: fixture.releaseDirectory,
          expectedVersion: fixture.version,
          run: { ...STAGE_RUN, ...drift },
        }),
      /stage workflow run/u,
    );
  }
});

test('finalization rejects a release record whose product tag does not match its version', () => {
  const fixture = createPreparedCandidate();
  const recordPath = join(fixture.releaseDirectory, 'release.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, `${JSON.stringify({ ...record, productTag: 'v9.9.9' }, null, 2)}\n`);

  assert.throws(
    () =>
      validateStageRun({
        releaseDirectory: fixture.releaseDirectory,
        expectedVersion: fixture.version,
        run: STAGE_RUN,
      }),
    /productTag is inconsistent/u,
  );
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
  const registryRecord = JSON.parse(readFileSync(join(registryDirectory, 'release.json'), 'utf8'));
  assert.equal(registryRecord.version, result.version);

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
  const chunkBytes = 1024 * 1024;
  const offeredChunks = Math.floor(CLI_RELEASE_ARTIFACT_LIMITS.compressedBytes / chunkBytes) + 8;
  let pulls = 0;
  const fetchImpl = async (input, options) => {
    if (String(input) !== tarballUrl) return fallback(input, options);
    return new Response(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > offeredChunks) return controller.close();
          controller.enqueue(new Uint8Array(chunkBytes));
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
  assert.ok(pulls < offeredChunks, `expected an early bounded read, consumed ${pulls} chunks`);
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
        attestationBundles: [provenanceBundle()],
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

test('signature audit binds provenance to the exact main publisher workflow and run', () => {
  const fixture = createPreparedCandidate();
  const audit = (mutate) => ({
    invalid: [],
    missing: [],
    verified: [
      {
        name: 'maka-agent',
        version: fixture.version,
        attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
        attestationBundles: [provenanceBundle(mutate)],
      },
    ],
  });
  for (const mutate of [
    (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'c'.repeat(40);
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.ref = `refs/tags/${PRODUCT_TAG}`;
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path =
        '.github/workflows/other.yml';
    },
    (statement) => {
      statement.predicate.runDetails.metadata.invocationId =
        'https://github.com/apache/maka/actions/runs/999/attempts/1';
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.repository =
        'https://github.com/other/repository';
    },
  ]) {
    assert.throws(
      () =>
        validateSignatureAudit({
          releaseDirectory: fixture.releaseDirectory,
          audit: audit(mutate),
        }),
      /provenance does not match/u,
    );
  }
  const wrongPredicate = provenanceBundle();
  wrongPredicate.predicateType = 'https://example.invalid/provenance';
  assert.throws(
    () =>
      validateSignatureAudit({
        releaseDirectory: fixture.releaseDirectory,
        audit: {
          invalid: [],
          missing: [],
          verified: [
            {
              name: 'maka-agent',
              version: fixture.version,
              attestations: { provenance: {} },
              attestationBundles: [wrongPredicate],
            },
          ],
        },
      }),
    /provenance does not match/u,
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

test('prepare-stage CLI emits only consumed GitHub Actions outputs', () => {
  const fixture = createCandidate(CURRENT_CLI_VERSION);
  const output = join(fixture.root, 'github-output.txt');
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'release-cli-publication.mjs'),
      'prepare-stage',
      fixture.releaseDirectory,
      fixture.version,
      `v${fixture.version}`,
      SOURCE_SHA,
      PUBLISHER_SHA,
      '321',
      '1',
      'apache/maka',
      WORKFLOW_PATH,
      output,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
    `version=${fixture.version}`,
    'dist_tag=latest',
    `tarball=${fixture.tarballPath}`,
  ]);
});

test('validate-stage-run CLI accepts the canonical staged release identity', () => {
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
      head_sha: PUBLISHER_SHA,
      conclusion: 'success',
      head_repository: { full_name: 'apache/maka' },
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
    `product_tag=${PRODUCT_TAG}`,
    `source_commit=${SOURCE_SHA}`,
    `version=${fixture.version}`,
  ]);
});

function createPreparedCandidate() {
  const fixture = createCandidate();
  prepareStageRelease({
    repoRoot: fixture.root,
    releaseDirectory: fixture.releaseDirectory,
    expectedVersion: fixture.version,
    productTag: `v${fixture.version}`,
    sourceSha: SOURCE_SHA,
    publisherSha: PUBLISHER_SHA,
    runId: '321',
    runAttempt: '1',
    repository: 'apache/maka',
    workflowPath: WORKFLOW_PATH,
  });
  return fixture;
}

function provenanceBundle(mutate = () => {}) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            repository: 'https://github.com/apache/maka',
            ref: 'refs/heads/main',
            path: WORKFLOW_PATH,
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/apache/maka@refs/heads/main',
            digest: { gitCommit: PUBLISHER_SHA },
          },
        ],
        internalParameters: { github: { event_name: 'workflow_dispatch' } },
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: {
          invocationId: 'https://github.com/apache/maka/actions/runs/321/attempts/1',
        },
      },
    },
  };
  mutate(statement);
  return {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
        signatures: [{ keyid: '', sig: 'verified-by-npm' }],
      },
    },
  };
}

function createCandidate(version = '0.2.0', sourceVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'maka-cli-publication-'));
  const releaseDirectory = join(root, 'packages/cli/release');
  const tarball = `maka-agent-${version}.tgz`;
  const tarballPath = join(releaseDirectory, tarball);
  const bytes = Buffer.from('immutable cli tarball');
  const sha256 = digest('sha256', bytes, 'hex');
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@11.19.0"}\n');
  writeFileSync(
    join(root, 'packages/cli/package.json'),
    `${JSON.stringify({ name: 'maka-agent', version: sourceVersion })}\n`,
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
      return Response.json({ 'dist-tags': { latest: fixture.version } });
    }
    if (url === tarballUrl) return new Response(bytes);
    return new Response('not found', { status: 404 });
  };
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
