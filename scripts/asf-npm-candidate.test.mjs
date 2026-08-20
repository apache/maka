import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createAsfNpmCandidateRecord,
  parseAsfSourceCandidateTag,
  verifyAsfNpmCandidateRecord,
} from './asf-npm-candidate.mjs';

const VERSION = '0.1.11';
const COMMIT = 'a'.repeat(40);

test('records and independently verifies one npm candidate bound to an ASF source RC', async (t) => {
  const fixture = await createFixture(t);
  const { record, recordPath } = createAsfNpmCandidateRecord({
    repoRoot: fixture.repoRoot,
    releaseDirectory: fixture.releaseDirectory,
    version: VERSION,
    sourceCandidateTag: `v${VERSION}-incubating-rc2`,
    sourceCommit: COMMIT,
    runId: '1234',
    runAttempt: '2',
  });

  assert.deepEqual(record.sourceRelease, {
    candidateTag: `v${VERSION}-incubating-rc2`,
    rc: 2,
    commit: COMMIT,
  });
  assert.equal(record.digests.sha512, digest(fixture.tarball, 'sha512'));
  assert.equal(verifyAsfNpmCandidateRecord({ recordPath }).record.version, VERSION);
});

test('rejects source tags that do not identify the exact version and positive RC', () => {
  for (const tag of [
    'v0.1.12-incubating-rc1',
    `v${VERSION}-incubating-rc0`,
    `v${VERSION}-incubating-rc01`,
  ]) {
    assert.throws(
      () => parseAsfSourceCandidateTag(tag, VERSION),
      /Source candidate tag must match/u,
    );
  }
});

test('verification rejects candidate bytes changed after the record was created', async (t) => {
  const fixture = await createFixture(t);
  const { recordPath } = createAsfNpmCandidateRecord({
    repoRoot: fixture.repoRoot,
    releaseDirectory: fixture.releaseDirectory,
    version: VERSION,
    sourceCandidateTag: `v${VERSION}-incubating-rc1`,
    sourceCommit: COMMIT,
    runId: '1234',
    runAttempt: '1',
  });

  await writeFile(fixture.tarballPath, 'replacement bytes');
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
    sourceCandidateTag: `v${VERSION}-incubating-rc1`,
    sourceCommit: COMMIT,
    runId: '1234',
    runAttempt: '1',
  });
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  delete record.workflow.path;
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  assert.throws(() => verifyAsfNpmCandidateRecord({ recordPath }), /workflow identity fields/u);
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
  await writeFile(`${tarballPath}.sha512`, `${digest(tarball, 'sha512')}  ${tarballName}\n`);
  await writeFile(
    `${tarballPath}.files.json`,
    `${JSON.stringify([{ path: 'dist/cli.js', size: 1 }], null, 2)}\n`,
  );
  return { repoRoot, releaseDirectory, tarball, tarballPath };
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}
