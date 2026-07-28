import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertMachOHeader,
  assertPinnedCuaDriverChecksums,
  assertSafeTarEntries,
  assertSafeTarListing,
  cuaDriverDownloadUrl,
  downloadFileWithSha256,
  verifyBinaryMetadata,
  verifyBinaryVersion,
} from './prepare-cua-driver.mjs';
import { cuaDriverDistributionBlockers } from './check-cua-driver-bundle.mjs';

const manifest = JSON.parse(
  await readFile(new URL('../apps/desktop/bundled-tools.json', import.meta.url)),
);
const cua = manifest.cuaDriver;

test('cua-driver release pins archive, binary, source, and license independently', () => {
  assertPinnedCuaDriverChecksums(cua);
  assert.notEqual(cua.archiveSha256, cua.binarySha256);
  // An upstream release is pinned by the tag and commit it was built from. A
  // fork build additionally pins sourceCommit / upstreamMergeCommit, which
  // have no meaning here — there is no merge to name.
  assert.equal(cua.buildProvenance, 'upstream-release');
  assert.equal(cua.upstreamTag, cua.tag);
  assert.equal(cua.sourceCommit, undefined);
  assert.equal(cua.upstreamMergeCommit, undefined);
  assert.match(cua.upstreamCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(cua.architectures, ['arm64', 'x86_64']);
  // Developer ID rather than ad-hoc: TCC grants anchor to the signing
  // identity, so this is what makes the bundled binary's grants stable.
  assert.equal(cua.signature, 'developer-id');
  assert.equal(cua.archiveSizeBytes, 32831352);
  assert.equal(cua.binarySizeBytes, 49466304);
  assert.equal(cua.licenseSizeBytes, 1069);
  assert.equal(cua.sourceSizeBytes, 509);
  assert.equal(
    cuaDriverDownloadUrl(cua.tag, cua.asset),
    `https://github.com/${cua.repo}/releases/download/${cua.tag}/${cua.asset}`,
  );
});

test('download streams to disk with a hard byte ceiling and incremental SHA-256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-download-test-'));
  try {
    const destination = join(directory, 'archive.tar.gz');
    const chunks = [Buffer.from('abc'), Buffer.from('def')];
    const result = await downloadFileWithSha256('https://example.test/cua-driver', destination, {
      maxBytes: 6,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    });
    assert.deepEqual(result, {
      bytes: 6,
      sha256: sha256(Buffer.concat(chunks)),
    });
    assert.equal((await readFile(destination)).toString(), 'abcdef');

    const oversized = join(directory, 'oversized.tar.gz');
    await assert.rejects(
      downloadFileWithSha256('https://example.test/oversized', oversized, {
        maxBytes: 5,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('abc'));
                controller.enqueue(Buffer.from('def'));
                controller.close();
              },
            }),
          ),
      }),
      /received more than 5 bytes/,
    );
    await assert.rejects(access(oversized));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mach-O, architecture, and signature gates run before the binary version', async () => {
  assert.doesNotThrow(() => assertMachOHeader(Buffer.from('cafebabe', 'hex')));
  assert.throws(() => assertMachOHeader(Buffer.from('#!/b')));

  const directory = await mkdtemp(join(tmpdir(), 'maka-cua-binary-gate-test-'));
  try {
    const binaryPath = join(directory, 'cua-driver');
    await writeFile(binaryPath, Buffer.concat([Buffer.from('cafebabe', 'hex'), Buffer.alloc(4)]));
    const entry = {
      binarySizeBytes: 8,
      architectures: ['arm64', 'x86_64'],
      signature: 'adhoc',
      expectedVersion: '0.7.1',
    };
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'codesign' && args[0] === '--display') {
        return { stdout: '', stderr: 'Signature=adhoc\n' };
      }
      if (command === binaryPath) {
        return { stdout: 'cua-driver 0.7.1\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    await verifyBinaryMetadata(binaryPath, entry, runCommand);
    await verifyBinaryVersion(binaryPath, entry, runCommand);
    assert.deepEqual(calls, [
      ['lipo', binaryPath, '-verify_arch', 'arm64', 'x86_64'],
      ['codesign', '--verify', '--strict', '--verbose=2', binaryPath],
      ['codesign', '--display', '--verbose=4', binaryPath],
      [binaryPath, '--version'],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prepare gates provenance after metadata and before executing --version', async () => {
  const source = await readFile(new URL('./prepare-cua-driver.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function prepareCuaDriver'));
  const metadata = body.indexOf('await verifyBinaryMetadata(found[0])');
  const provenance = body.indexOf('assertSourceProvenance(JSON.parse(sourceBytes.toString');
  const version = body.indexOf('await verifyBinaryVersion(found[0])');
  assert.ok(metadata >= 0 && provenance > metadata && version > provenance);
});

test('tar entry validation rejects path traversal before extraction', () => {
  assertSafeTarEntries(['bundle/cua-driver', 'bundle/LICENSE.md']);
  assert.throws(() => assertSafeTarEntries(['../../tmp/escape']));
  assert.throws(() => assertSafeTarEntries(['/absolute/path']));
  assert.throws(() => assertSafeTarEntries(['windows\\escape']));
  assertSafeTarListing([
    'drwxr-xr-x user/group 0 2026-01-01 00:00 bundle/',
    '-rwxr-xr-x user/group 1 2026-01-01 00:00 bundle/cua-driver',
  ]);
  assert.throws(() =>
    assertSafeTarListing(['lrwxr-xr-x user/group 0 2026-01-01 00:00 bundle/link -> /tmp/escape']),
  );
});

test('tracked license and source metadata match the manifest pins', async () => {
  const license = await readFile(
    new URL('../apps/desktop/resources/licenses/cua-driver/LICENSE.md', import.meta.url),
  );
  const sourceBytes = await readFile(
    new URL('../apps/desktop/resources/licenses/cua-driver/SOURCE.json', import.meta.url),
  );
  assert.equal(sha256(license), cua.licenseSha256);
  assert.equal(sha256(sourceBytes), cua.sourceSha256);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  assert.equal(source.repository, cua.repo);
  assert.equal(source.upstreamCommit, cua.upstreamCommit);
  assert.equal(source.sourceCommit, cua.sourceCommit);
  assert.equal(source.patchPullRequest, cua.patchPullRequest);
  assert.equal(source.cargoLockSha256, cua.cargoLockSha256);
});

test('artifact checks remain separate from the distribution release gate', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const [checkSource, prepareSource] = await Promise.all([
    readFile(new URL('./check-cua-driver-bundle.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./prepare-cua-driver.mjs', import.meta.url), 'utf8'),
  ]);
  assert.ok(pkg.scripts['check:cua-driver-artifact']);
  assert.doesNotMatch(pkg.scripts['check:release'], /cua-driver/);
  assert.match(checkSource, /releaseSigningReady:\s*false/);
  assert.match(checkSource, /verifyBinaryMetadata/);
  assert.match(prepareSource, /codesign/);
  assert.doesNotMatch(
    `${checkSource}\n${prepareSource}`,
    /notarytool|stapler|Developer ID Application/,
  );
  // The pinned binary is Developer ID signed by Cua AI, Inc., so that blocker
  // is cleared. The rest still stand: Maka does not notarize, attest, or
  // otherwise take distribution responsibility for a third-party binary.
  assert.deepEqual(cuaDriverDistributionBlockers(cua), [
    'notarization',
    'artifact_attestation',
    'build_provenance',
    'third_party_notices',
    'distribution_ready',
  ]);
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
