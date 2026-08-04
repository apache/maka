import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  link as createHardLink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  createSessionBundleFileService,
  decodeSessionBundleUstarHeaderV1,
  encodeSessionBundleManifestV1,
  SessionBundleFileError,
  type SessionBundleArtifact,
  type SessionBundleLimits,
} from '../index.js';

const roots: string[] = [];
const identityBytes = Buffer.from('{"schemaVersion":1,"makaSessionId":"maka-α"}', 'utf8');
const limits: SessionBundleLimits = {
  maxCompressedBytes: 4 * 1024 * 1024,
  maxDecompressedTarBytes: 8 * 1024 * 1024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxEntryCount: 100,
  maxManifestBytes: 256 * 1024,
  maxStateIdentityBytes: 64 * 1024,
  maxPathBytes: 255,
  maxPathDepth: 16,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('packs deterministically, inspects completely, and atomically hydrates', async () => {
  const fixture = await createFixture();
  const service = createSessionBundleFileService();
  const firstPath = join(fixture.root, 'first.tar.zst');
  const secondPath = join(fixture.root, 'second.tar.zst');

  const first = await packFixture(firstPath, fixture);
  const second = await packFixture(secondPath, fixture);
  const firstBytes = await readFile(firstPath);
  const secondBytes = await readFile(secondPath);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(second.archiveDigest, first.archiveDigest);
  assert.equal(first.compressedBytes, firstBytes.byteLength);
  assert.equal(first.entryCount, 8);
  assert.equal(first.payloadBytes, identityBytes.byteLength + 5 + 18 + Buffer.byteLength('好'));

  const tar = zstdDecompressSync(firstBytes);
  assert.equal(tar.byteLength, first.decompressedTarBytes);
  assert.equal(
    tar.subarray(-1024).every((byte) => byte === 0),
    true,
  );
  assert.equal(
    createHash('sha256').update(tar).digest('hex'),
    '5aed5bb2802d79826339fcc89f0c0aaf657c36d898452e22ef972fb6d5306148',
  );
  assert.equal(
    first.archiveDigest,
    'sha256:c7c9efbe9fc8a1c84f22ec016985457d82070001c4579d5cecb1304459fed5e1',
  );
  assert.equal(firstBytes.lastIndexOf(Buffer.from('28b52ffd', 'hex')), 0);

  const inspected = await service.inspect({
    source: { path: firstPath, expectedArchiveDigest: first.archiveDigest },
    limits,
  });
  assert.equal(inspected.verified, true);
  assert.equal(inspected.manifest.envelope.sessionId, 'cloud-session-1');
  assert.equal(inspected.manifest.envelope.lastCommittedActivationId, 'activation-9');
  assert.deepEqual(Buffer.from(inspected.stateIdentity.bytes), identityBytes);

  const destinationRoot = join(fixture.root, 'hydrated');
  const hydrated = await service.hydrate({
    source: { path: firstPath, expectedArchiveDigest: first.archiveDigest },
    limits,
    expectedSessionId: 'cloud-session-1',
    destinationRoot,
  });
  assert.equal(hydrated.destinationRoot, destinationRoot);
  assert.equal(hydrated.stateRoot, join(destinationRoot, 'state'));
  assert.equal(hydrated.workspaceRoot, join(destinationRoot, 'workspace'));
  assert.deepEqual(await readFile(join(destinationRoot, 'state-identity.json')), identityBytes);
  assert.equal(await readFile(join(destinationRoot, 'state', 'session.bin'), 'utf8'), 'state');
  assert.equal(
    await readFile(join(destinationRoot, 'workspace', 'run.sh'), 'utf8'),
    '#!/bin/sh\necho ok\n',
  );
  assert.equal(await readFile(join(destinationRoot, 'workspace', '深', 'x.txt'), 'utf8'), '好');
  assert.equal((await stat(join(destinationRoot, 'workspace', 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await stat(join(destinationRoot, 'state', 'session.bin'))).mode & 0o777, 0o644);
  await assert.rejects(lstat(join(destinationRoot, 'manifest.json')), { code: 'ENOENT' });
});

test('an independent process verifies and hydrates the same archive contract', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  const artifact = await packFixture(archivePath, fixture);
  const childPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'session-bundle-inspect-child.js',
  );
  const destinationRoot = join(fixture.root, 'child-hydrated');
  const child = spawn(
    process.execPath,
    [childPath, archivePath, artifact.archiveDigest, JSON.stringify(limits), destinationRoot],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString('utf8')), {
    sessionId: 'cloud-session-1',
    archiveDigest: artifact.archiveDigest,
    identityHex: identityBytes.toString('hex'),
    verified: true,
    destinationRoot,
  });
  assert.equal(await readFile(join(destinationRoot, 'state', 'session.bin'), 'utf8'), 'state');
  assert.equal(
    await readFile(join(destinationRoot, 'workspace', 'run.sh'), 'utf8'),
    '#!/bin/sh\necho ok\n',
  );
});

test('concurrent publications never overwrite an existing destination', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'concurrent.tar.zst');
  const packResults = await Promise.allSettled(
    Array.from({ length: 8 }, () => packFixture(archivePath, fixture)),
  );
  assert.equal(packResults.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of packResults) {
    if (result.status === 'rejected') assertBundleErrorValue(result.reason, 'destination_exists');
  }

  const artifact = packResults.find(
    (result): result is PromiseFulfilledResult<SessionBundleArtifact> =>
      result.status === 'fulfilled',
  )?.value;
  assert.ok(artifact);
  const destinationRoot = join(fixture.root, 'concurrent-hydration');
  const service = createSessionBundleFileService();
  const hydrateInput = {
    source: { path: archivePath, expectedArchiveDigest: artifact.archiveDigest },
    limits,
    expectedSessionId: 'cloud-session-1',
    destinationRoot,
  } as const;
  const hydrateResults = await Promise.allSettled([
    service.hydrate(hydrateInput),
    service.hydrate(hydrateInput),
  ]);
  assert.equal(hydrateResults.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of hydrateResults) {
    if (result.status === 'rejected') assertBundleErrorValue(result.reason, 'destination_exists');
  }
  assert.equal(
    await readFile(join(destinationRoot, 'workspace', 'run.sh'), 'utf8'),
    '#!/bin/sh\necho ok\n',
  );
});

test('binds pack publication and cleanup to the hashed temporary inode', async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.workspaceRoot, 'large.bin'), randomBytes(8 * 1024 * 1024));
  const destination = join(fixture.root, 'inode-bound.tar.zst');
  const replacementResultPath = join(fixture.root, 'replacement-result.json');
  const replacerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'session-bundle-pack-temp-replacer.js',
  );
  const replacer = spawn(process.execPath, [replacerPath, fixture.root, replacementResultPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(replacer.stdout, 'data');
  const packing = packFixture(destination, fixture, {
    ...limits,
    maxCompressedBytes: 16 * 1024 * 1024,
    maxDecompressedTarBytes: 16 * 1024 * 1024,
    maxPayloadBytes: 16 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
  });
  const [replacerCode] = (await once(replacer, 'exit')) as [number | null];
  assert.equal(replacerCode, 0);
  const { capturedPath, temporaryPath } = JSON.parse(
    await readFile(replacementResultPath, 'utf8'),
  ) as { capturedPath: string; temporaryPath: string };

  await assertBundleRejects(packing, 'source_changed');
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.equal(await readFile(temporaryPath, 'utf8'), 'EVIL');
  assert.equal((await lstat(capturedPath)).isFile(), true);
});

test('rejects corrupted payloads and transport mismatches without publishing hydration', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  const artifact = await packFixture(archivePath, fixture);
  const service = createSessionBundleFileService();
  const corruptedPath = join(fixture.root, 'corrupted.tar.zst');
  const tar = zstdDecompressSync(await readFile(archivePath));
  const payload = findTarEntry(tar, 'state/session.bin');
  tar[payload.contentOffset] ^= 0xff;
  await writeFile(corruptedPath, compressTar(tar));

  await assertBundleRejects(
    service.inspect({ source: { path: corruptedPath }, limits }),
    'integrity_mismatch',
  );
  const destinationRoot = join(fixture.root, 'failed-hydration');
  await assertBundleRejects(
    service.hydrate({
      source: { path: archivePath, expectedArchiveDigest: `sha256:${'00'.repeat(32)}` },
      limits,
      expectedSessionId: 'cloud-session-1',
      destinationRoot,
    }),
    'integrity_mismatch',
  );
  await assert.rejects(lstat(destinationRoot), { code: 'ENOENT' });
  assert.equal(
    (await readdir(fixture.root)).some((name) => name.includes('.maka-session-bundle-staging-')),
    false,
  );
  assert.notEqual(artifact.archiveDigest, `sha256:${'00'.repeat(32)}`);
});

test('rejects corrupted manifest, descriptor, tree digest, and Zstandard stream', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  await packFixture(archivePath, fixture);
  const archiveBytes = await readFile(archivePath);
  const originalTar = zstdDecompressSync(archiveBytes);
  const service = createSessionBundleFileService();

  const manifest = Buffer.from(originalTar);
  const manifestEntry = findTarEntry(manifest, 'manifest.json');
  manifest[manifestEntry.contentOffset] = '['.charCodeAt(0);
  await assertMutatedTarRejected(service, fixture.root, 'manifest', manifest, 'invalid_manifest');

  const descriptor = Buffer.from(originalTar);
  const descriptorEntry = findTarEntry(descriptor, 'state-identity.json');
  descriptor[descriptorEntry.contentOffset] ^= 0xff;
  await assertMutatedTarRejected(
    service,
    fixture.root,
    'descriptor',
    descriptor,
    'integrity_mismatch',
  );

  const treeDigest = Buffer.from(originalTar);
  const treeManifestEntry = findTarEntry(treeDigest, 'manifest.json');
  const decodedManifest = JSON.parse(
    treeDigest
      .subarray(
        treeManifestEntry.contentOffset,
        treeManifestEntry.contentOffset + treeManifestEntry.size,
      )
      .toString('utf8'),
  ) as Parameters<typeof encodeSessionBundleManifestV1>[0];
  decodedManifest.payload.treeDigest = `sha256:${'00'.repeat(32)}`;
  const changedManifest = Buffer.from(encodeSessionBundleManifestV1(decodedManifest));
  assert.equal(changedManifest.byteLength, treeManifestEntry.size);
  changedManifest.copy(treeDigest, treeManifestEntry.contentOffset);
  await assertMutatedTarRejected(
    service,
    fixture.root,
    'tree-digest',
    treeDigest,
    'integrity_mismatch',
  );

  const truncatedZstandardPath = join(fixture.root, 'corrupted-zstd.tar.zst');
  const corruptedZstandard = Buffer.from(archiveBytes);
  corruptedZstandard[0] ^= 0xff;
  await writeFile(truncatedZstandardPath, corruptedZstandard);
  await assertBundleRejects(
    service.inspect({ source: { path: truncatedZstandardPath }, limits }),
    'integrity_mismatch',
  );

  const trailingZstandardPath = join(fixture.root, 'trailing-zstd.tar.zst');
  await writeFile(trailingZstandardPath, Buffer.concat([archiveBytes, Buffer.from([0])]));
  await assertBundleRejects(
    service.inspect({ source: { path: trailingZstandardPath }, limits }),
    'integrity_mismatch',
  );

  const noncanonicalZstandardPath = join(fixture.root, 'noncanonical-zstd.tar.zst');
  await writeFile(noncanonicalZstandardPath, zstdCompressSync(originalTar));
  await assertBundleRejects(
    service.inspect({ source: { path: noncanonicalZstandardPath }, limits }),
    'integrity_mismatch',
  );

  const oversizedWindowPath = join(fixture.root, 'oversized-window-zstd.tar.zst');
  const oversizedWindow = Buffer.from(archiveBytes);
  assert.equal(oversizedWindow[5], 0x58);
  oversizedWindow[5] = 0x60;
  await writeFile(oversizedWindowPath, oversizedWindow);
  await assertBundleRejects(
    service.inspect({ source: { path: oversizedWindowPath }, limits }),
    'integrity_mismatch',
  );

  const emptyFrame = compressTar(Buffer.alloc(0));
  assert.equal(zstdDecompressSync(emptyFrame).byteLength, 0);
  const multipleFramesPath = join(fixture.root, 'multiple-frames-zstd.tar.zst');
  await writeFile(multipleFramesPath, Buffer.concat([archiveBytes, emptyFrame]));
  await assertBundleRejects(
    service.inspect({ source: { path: multipleFramesPath }, limits }),
    'integrity_mismatch',
  );
});

test('enforces every explicit streaming quota with bounded details', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  const artifact = await packFixture(archivePath, fixture);
  const service = createSessionBundleFileService();
  const cases: Array<[keyof SessionBundleLimits, number]> = [
    ['maxCompressedBytes', artifact.compressedBytes - 1],
    ['maxDecompressedTarBytes', artifact.decompressedTarBytes - 1],
    ['maxPayloadBytes', artifact.payloadBytes - 1],
    ['maxFileBytes', 17],
    ['maxEntryCount', artifact.entryCount - 1],
    ['maxManifestBytes', 1],
    ['maxStateIdentityBytes', identityBytes.byteLength - 1],
    ['maxPathBytes', 18],
    ['maxPathDepth', 2],
  ];

  for (const [quota, value] of cases) {
    await assert.rejects(
      service.inspect({ source: { path: archivePath }, limits: { ...limits, [quota]: value } }),
      (error) => {
        assert.ok(error instanceof SessionBundleFileError);
        assert.equal(error.code, 'quota_exceeded', quota);
        assert.equal(error.details?.quota, quota);
        assert.equal(error.details?.limit, value);
        return true;
      },
    );
  }
});

test('rejects unsafe paths, links, bad checksums, truncation, and trailing TAR bytes', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  await packFixture(archivePath, fixture);
  const originalTar = zstdDecompressSync(await readFile(archivePath));
  const service = createSessionBundleFileService();

  const unsafe = Buffer.from(originalTar);
  const unsafeEntry = findTarEntry(unsafe, 'state/session.bin');
  rewriteHeaderName(
    unsafe.subarray(unsafeEntry.headerOffset, unsafeEntry.headerOffset + 512),
    '../outside',
  );
  await assertMutatedTarRejected(service, fixture.root, 'unsafe', unsafe, 'unsafe_path');

  const link = Buffer.from(originalTar);
  const linkEntry = findTarEntry(link, 'workspace/run.sh');
  const linkHeader = link.subarray(linkEntry.headerOffset, linkEntry.headerOffset + 512);
  linkHeader[156] = '2'.charCodeAt(0);
  rewriteChecksum(linkHeader);
  await assertMutatedTarRejected(service, fixture.root, 'link', link, 'unsupported_entry');

  const checksum = Buffer.from(originalTar);
  const checksumEntry = findTarEntry(checksum, 'workspace/run.sh');
  checksum[checksumEntry.headerOffset + 148] ^= 1;
  await assertMutatedTarRejected(service, fixture.root, 'checksum', checksum, 'integrity_mismatch');

  const truncated = originalTar.subarray(0, originalTar.byteLength - 512);
  await assertMutatedTarRejected(
    service,
    fixture.root,
    'truncated',
    truncated,
    'integrity_mismatch',
  );

  const trailing = Buffer.concat([originalTar, Buffer.alloc(512)]);
  await assertMutatedTarRejected(service, fixture.root, 'trailing', trailing, 'integrity_mismatch');

  const duplicate = Buffer.from(originalTar);
  const duplicateEntry = findTarEntry(duplicate, 'workspace/深/x.txt');
  rewriteHeaderName(
    duplicate.subarray(duplicateEntry.headerOffset, duplicateEntry.headerOffset + 512),
    'workspace/run.sh',
  );
  await assertMutatedTarRejected(service, fixture.root, 'duplicate', duplicate, 'unsafe_path');
});

test('unsafe hydration cannot escape staging or remove unrelated paths', async () => {
  const fixture = await createFixture();
  const archivePath = join(fixture.root, 'bundle.tar.zst');
  await packFixture(archivePath, fixture);
  const unsafe = zstdDecompressSync(await readFile(archivePath));
  const unsafeEntry = findTarEntry(unsafe, 'state/session.bin');
  rewriteHeaderName(
    unsafe.subarray(unsafeEntry.headerOffset, unsafeEntry.headerOffset + 512),
    '../outside',
  );
  const unsafeArchivePath = join(fixture.root, 'unsafe-hydrate.tar.zst');
  await writeFile(unsafeArchivePath, compressTar(unsafe));

  const outsidePath = join(fixture.root, 'outside');
  await writeFile(outsidePath, 'sentinel');
  const unrelatedRoot = await mkdtemp(join(tmpdir(), 'maka-session-bundle-unrelated-'));
  roots.push(unrelatedRoot);
  await writeFile(join(unrelatedRoot, 'sentinel'), 'unrelated');
  const unrelatedLink = join(
    fixture.root,
    '.unsafe-destination.maka-session-bundle-staging-unrelated',
  );
  await symlink(unrelatedRoot, unrelatedLink);

  const destinationRoot = join(fixture.root, 'unsafe-destination');
  await assertBundleRejects(
    createSessionBundleFileService().hydrate({
      source: { path: unsafeArchivePath },
      limits,
      expectedSessionId: 'cloud-session-1',
      destinationRoot,
    }),
    'unsafe_path',
  );
  assert.equal(await readFile(outsidePath, 'utf8'), 'sentinel');
  assert.equal((await lstat(unrelatedLink)).isSymbolicLink(), true);
  assert.equal(await readFile(join(unrelatedRoot, 'sentinel'), 'utf8'), 'unrelated');
  await assert.rejects(lstat(destinationRoot), { code: 'ENOENT' });
});

test('pack enforces caller quotas and cleans unpublished output', async () => {
  const fixture = await createFixture();
  const cases: Array<[keyof SessionBundleLimits, number]> = [
    ['maxCompressedBytes', 1],
    ['maxDecompressedTarBytes', 1],
    ['maxPayloadBytes', identityBytes.byteLength],
    ['maxFileBytes', 4],
    ['maxEntryCount', 1],
    ['maxManifestBytes', 1],
    ['maxStateIdentityBytes', identityBytes.byteLength - 1],
    ['maxPathBytes', Buffer.byteLength('state-identity.json') - 1],
    ['maxPathDepth', 1],
  ];

  for (const [quota, value] of cases) {
    const destination = join(fixture.root, `${quota}.tar.zst`);
    await assert.rejects(
      packFixture(destination, fixture, { ...limits, [quota]: value }),
      (error) => {
        assert.ok(error instanceof SessionBundleFileError);
        assert.equal(error.code, 'quota_exceeded', quota);
        assert.equal(error.details?.quota, quota);
        return true;
      },
    );
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  }
  assert.equal(
    (await readdir(fixture.root)).some((name) => name.includes('.maka-session-bundle-pack-')),
    false,
  );
});

test('rejects source links, identity mismatch, and existing destinations', async () => {
  const fixture = await createFixture();
  const service = createSessionBundleFileService();
  await symlink(join(fixture.stateRoot, 'session.bin'), join(fixture.stateRoot, 'linked.bin'));
  await assertBundleRejects(
    packFixture(join(fixture.root, 'linked.tar.zst'), fixture),
    'unsupported_entry',
  );
  await rm(join(fixture.stateRoot, 'linked.bin'));

  const hardLinkPath = join(fixture.workspaceRoot, 'hard-linked.bin');
  await createHardLink(join(fixture.stateRoot, 'session.bin'), hardLinkPath);
  await assertBundleRejects(
    packFixture(join(fixture.root, 'hard-linked.tar.zst'), fixture),
    'unsupported_entry',
  );
  await rm(hardLinkPath);

  if (process.platform === 'linux') {
    const invalidUtf8Path = Buffer.concat([
      Buffer.from(`${fixture.stateRoot}/`, 'utf8'),
      Buffer.from([0xff]),
    ]);
    await writeFile(invalidUtf8Path, 'invalid UTF-8 name');
    await assertBundleRejects(
      packFixture(join(fixture.root, 'invalid-utf8.tar.zst'), fixture),
      'unsafe_path',
    );
    await rm(invalidUtf8Path);
  }

  const archivePath = join(fixture.root, 'bundle.tar.zst');
  await packFixture(archivePath, fixture);
  await assertBundleRejects(
    service.hydrate({
      source: { path: archivePath },
      limits,
      expectedSessionId: 'wrong-session',
      destinationRoot: join(fixture.root, 'identity-mismatch'),
    }),
    'identity_mismatch',
  );

  const destinationRoot = join(fixture.root, 'existing');
  await mkdir(destinationRoot);
  await assertBundleRejects(
    service.hydrate({
      source: { path: archivePath },
      limits,
      expectedSessionId: 'cloud-session-1',
      destinationRoot,
    }),
    'destination_exists',
  );
});

async function createFixture(): Promise<{
  root: string;
  stateRoot: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-codec-'));
  roots.push(root);
  const stateRoot = join(root, 'source-state');
  const workspaceRoot = join(root, 'source-workspace');
  await mkdir(join(stateRoot, 'empty'), { recursive: true });
  await mkdir(join(workspaceRoot, '深'), { recursive: true });
  await writeFile(join(stateRoot, 'session.bin'), 'state');
  await writeFile(join(workspaceRoot, 'run.sh'), '#!/bin/sh\necho ok\n');
  await chmod(join(workspaceRoot, 'run.sh'), 0o755);
  await writeFile(join(workspaceRoot, '深', 'x.txt'), '好');
  return { root, stateRoot, workspaceRoot };
}

async function packFixture(
  destination: string,
  fixture: { stateRoot: string; workspaceRoot: string },
  packLimits: SessionBundleLimits = limits,
): Promise<SessionBundleArtifact> {
  return createSessionBundleFileService().pack({
    snapshot: {
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.workspaceRoot,
      stateIdentity: {
        mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
        bytes: identityBytes,
      },
    },
    envelope: {
      sessionId: 'cloud-session-1',
      lastCommittedActivationId: 'activation-9',
    },
    destination,
    limits: packLimits,
  });
}

function findTarEntry(
  tar: Buffer,
  target: string,
): { headerOffset: number; contentOffset: number; size: number } {
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const headerBytes = tar.subarray(offset, offset + 512);
    if (headerBytes.every((byte) => byte === 0)) break;
    const header = decodeSessionBundleUstarHeaderV1(headerBytes);
    const contentOffset = offset + 512;
    if (header.path === target) return { headerOffset: offset, contentOffset, size: header.size };
    offset = contentOffset + header.size + ((512 - (header.size % 512)) % 512);
  }
  throw new Error(`Missing TAR entry ${target}`);
}

function rewriteHeaderName(header: Buffer, path: string): void {
  assert.ok(Buffer.byteLength(path) <= 100);
  header.fill(0, 0, 100);
  header.write(path, 0, 'utf8');
  rewriteChecksum(header);
}

function rewriteChecksum(header: Buffer): void {
  header.fill(' '.charCodeAt(0), 148, 156);
  const checksum = header
    .reduce((sum, byte) => sum + byte, 0)
    .toString(8)
    .padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = ' '.charCodeAt(0);
}

function compressTar(tar: Uint8Array): Buffer {
  const compressed = zstdCompressSync(tar, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 3,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
      [zlibConstants.ZSTD_c_dictIDFlag]: 0,
      [zlibConstants.ZSTD_c_nbWorkers]: 0,
      [zlibConstants.ZSTD_c_windowLog]: 21,
    },
  });
  // One-shot compression shrinks the descriptor to the known input size; V1 pins 2 MiB.
  compressed[5] = 0x58;
  return compressed;
}

async function assertMutatedTarRejected(
  service: ReturnType<typeof createSessionBundleFileService>,
  root: string,
  name: string,
  tar: Uint8Array,
  code: SessionBundleFileError['code'],
): Promise<void> {
  const path = join(root, `${name}.tar.zst`);
  await writeFile(path, compressTar(tar));
  await assertBundleRejects(service.inspect({ source: { path }, limits }), code);
}

async function assertBundleRejects(
  action: Promise<unknown>,
  code: SessionBundleFileError['code'],
): Promise<void> {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof SessionBundleFileError);
    assert.equal(error.code, code);
    return true;
  });
}

function assertBundleErrorValue(error: unknown, code: SessionBundleFileError['code']): void {
  assert.ok(error instanceof SessionBundleFileError);
  assert.equal(error.code, code);
}
