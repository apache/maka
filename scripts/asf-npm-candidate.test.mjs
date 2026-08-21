import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createAsfNpmCandidateRecord,
  parseAsfSourceReferenceTag,
  verifyAsfNpmCandidateRecord,
} from './asf-npm-candidate.mjs';

const VERSION = '0.1.11';
const COMMIT = 'a'.repeat(40);
const REPOSITORY = 'apache/maka';

test('records and independently verifies one npm candidate bound to an ASF source RC', async (t) => {
  const fixture = await createFixture(t);
  const { record, recordPath } = createAsfNpmCandidateRecord({
    repoRoot: fixture.repoRoot,
    releaseDirectory: fixture.releaseDirectory,
    version: VERSION,
    sourceReferenceTag: `v${VERSION}-incubating-rc2`,
    sourceCommit: COMMIT,
    repository: REPOSITORY,
    runId: '1234',
    runAttempt: '2',
  });

  assert.deepEqual(record.sourceReference, {
    candidateTag: `v${VERSION}-incubating-rc2`,
    commit: COMMIT,
  });
  assert.equal(record.digests.sha512, digest(fixture.tarball, 'sha512'));
  assert.equal(
    await readFile(`${fixture.tarballPath}.sha512`, 'utf8'),
    `${digest(fixture.tarball, 'sha512')}  maka-agent-${VERSION}.tgz\n`,
  );
  assert.equal(verifyAsfNpmCandidateRecord({ recordPath }).record.version, VERSION);
});

test('rejects source tags that do not identify the exact version and positive RC', () => {
  for (const tag of [
    'v0.1.12-incubating-rc1',
    `v${VERSION}-incubating-rc0`,
    `v${VERSION}-incubating-rc01`,
  ]) {
    assert.throws(
      () => parseAsfSourceReferenceTag(tag, VERSION),
      /Source candidate tag must match/u,
    );
  }
});

test('verification rejects candidate integrity changes after the record was created', async (t) => {
  const fixture = await createFixture(t);
  const { recordPath } = createAsfNpmCandidateRecord({
    repoRoot: fixture.repoRoot,
    releaseDirectory: fixture.releaseDirectory,
    version: VERSION,
    sourceReferenceTag: `v${VERSION}-incubating-rc1`,
    sourceCommit: COMMIT,
    repository: REPOSITORY,
    runId: '1234',
    runAttempt: '1',
  });

  await writeFile(fixture.tarballPath, 'replacement bytes');
  assert.throws(
    () => verifyAsfNpmCandidateRecord({ recordPath }),
    /does not match the npm candidate/u,
  );

  await writeFile(fixture.tarballPath, fixture.tarball);
  await writeFile(
    `${fixture.tarballPath}.sha512`,
    `${'0'.repeat(128)}  maka-agent-${VERSION}.tgz\n`,
  );
  assert.throws(
    () => verifyAsfNpmCandidateRecord({ recordPath }),
    /does not match the npm candidate/u,
  );
});

test('verification rejects an incomplete workflow identity', async (t) => {
  const fixture = await createFixture(t);
  const { recordPath } = createAsfNpmCandidateRecord({
    repoRoot: fixture.repoRoot,
    releaseDirectory: fixture.releaseDirectory,
    version: VERSION,
    sourceReferenceTag: `v${VERSION}-incubating-rc1`,
    sourceCommit: COMMIT,
    repository: REPOSITORY,
    runId: '1234',
    runAttempt: '1',
  });
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.workflow.path;
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  assert.throws(() => verifyAsfNpmCandidateRecord({ recordPath }), /workflow identity fields/u);
});

test('record creation rejects workflow provenance from a fork', async (t) => {
  const fixture = await createFixture(t);
  assert.throws(
    () =>
      createAsfNpmCandidateRecord({
        repoRoot: fixture.repoRoot,
        releaseDirectory: fixture.releaseDirectory,
        version: VERSION,
        sourceReferenceTag: `v${VERSION}-incubating-rc1`,
        sourceCommit: COMMIT,
        repository: 'M4n5ter/maka-agent',
        runId: '1234',
        runAttempt: '1',
      }),
    /Workflow repository must be apache\/maka/u,
  );
});

async function createFixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'maka-asf-npm-candidate-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const releaseDirectory = join(repoRoot, 'packages/cli/release');
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ version: VERSION }));
  await writeFile(
    join(repoRoot, 'packages/cli/package.json'),
    JSON.stringify({ name: 'maka-agent', version: VERSION }),
  );
  const tarball = Buffer.from('reviewed npm candidate');
  const tarballName = `maka-agent-${VERSION}.tgz`;
  const tarballPath = join(releaseDirectory, tarballName);
  await writeFile(tarballPath, tarball);
  await writeFile(`${tarballPath}.sha256`, `${digest(tarball, 'sha256')}  ${tarballName}\n`);
  await writeFile(
    `${tarballPath}.files.json`,
    `${JSON.stringify([{ path: 'dist/cli.js', size: 1 }], null, 2)}\n`,
  );
  return { repoRoot, releaseDirectory, tarball, tarballPath };
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}
