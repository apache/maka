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
import {
  fetchRegistryRelease,
  parseCliReleaseVersion,
  prepareSignatureAuditTree,
  prepareStageRelease,
  validateRegistryChannels,
  validateSignatureAudit,
  validateStageRun,
} from './release-cli-publication.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const WORKFLOW_PATH = '.github/workflows/release-cli-stage.yml';
const CURRENT_CLI_VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../packages/cli/package.json'), 'utf8'),
).version;
const PRODUCT_TAG = 'v0.1.0-beta.1';
const STAGE_RUN = {
  id: 321,
  run_attempt: 1,
  path: WORKFLOW_PATH,
  event: 'workflow_dispatch',
  head_branch: PRODUCT_TAG,
  head_sha: SOURCE_SHA,
  conclusion: 'success',
  head_repository: { full_name: 'apache/maka' },
};

test('release versions map prereleases and stable versions to distinct channels', () => {
  assert.deepEqual(parseCliReleaseVersion('0.1.0-beta.1'), {
    version: '0.1.0-beta.1',
    distTag: 'next',
    tarball: 'maka-agent-0.1.0-beta.1.tgz',
  });
  assert.equal(parseCliReleaseVersion('0.1.0').distTag, 'latest');
  for (const version of ['01.0.0', '0.1', '0.1.0+local', '0.1.0-beta..1', '../0.1.0']) {
    assert.throws(() => parseCliReleaseVersion(version), /valid product release version/u);
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
    productTag: PRODUCT_TAG,
    sourceSha: SOURCE_SHA,
    runId: '321',
    runAttempt: '1',
    repository: 'apache/maka',
    workflowPath: WORKFLOW_PATH,
  });

  assert.equal(prepared.record.sha256, fixture.sha256);
  assert.equal(prepared.record.schemaVersion, 3);
  assert.equal(prepared.record.productTag, PRODUCT_TAG);
  assert.equal(prepared.record.source.commit, SOURCE_SHA);
  assert.equal(prepared.record.source.runId, '321');
  assert.equal(prepared.record.source.runAttempt, '1');
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
        runId: '321',
        runAttempt: '1',
        repository: 'apache/maka',
        workflowPath: WORKFLOW_PATH,
      }),
    /Product tag .* does not match/u,
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
        productTag: PRODUCT_TAG,
        sourceSha: SOURCE_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'apache/maka',
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
        productTag: PRODUCT_TAG,
        sourceSha: SOURCE_SHA,
        runId: '321',
        runAttempt: '1',
        repository: 'apache/maka',
        workflowPath: WORKFLOW_PATH,
      }),
    /checksum does not match/u,
  );
});

test('finalization accepts only the exact successful product-tag stage run', () => {
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
    { head_branch: 'v0.1.0-beta.2' },
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

test('signature audit binds provenance to the exact tag, source, workflow, and run', () => {
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
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40);
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main';
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
      head_branch: PRODUCT_TAG,
      head_sha: SOURCE_SHA,
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
            ref: `refs/tags/${PRODUCT_TAG}`,
            path: WORKFLOW_PATH,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/apache/maka@refs/tags/${PRODUCT_TAG}`,
            digest: { gitCommit: SOURCE_SHA },
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

function createCandidate(version = '0.1.0-beta.1') {
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

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
