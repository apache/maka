#!/usr/bin/env node
// Acquire + verify + extract the pinned cua-driver compatibility release for
// bundling into Maka.app. The source patch remains published in hqhq1025/cua
// and proposed upstream; Maka only consumes an immutable, provenance-carrying
// release artifact with a single-source version pin in
// apps/desktop/bundled-tools.json, checksum verified fail-closed, extracted to a
// pinned repo path (resources/bin/cua-driver), idempotent via a marker file.
//
// cua-driver ships ONE darwin-universal tarball (arm64 + x64), so unlike
// There is no per-arch asset. This tool is macOS-only (the Tier-2
// coordinate-injection backend); on other platforms this is a no-op.
//
// Dev usage: `npm run prepare:cua-driver`. The extracted binary is spawned as a
// DIRECT child by cua-driver-backend.ts. This script verifies that the release
// artifact has a valid code signature, but it does not claim Developer ID,
// notarization, Gatekeeper, or final Maka.app nested-signature readiness.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const binDir = join(repoRoot, 'apps', 'desktop', 'resources', 'bin');
const licenseDir = join(repoRoot, 'apps', 'desktop', 'resources', 'licenses', 'cua-driver');
const DEFAULT_FETCH_TIMEOUT_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MACH_O_MAGICS = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const cua = manifest.cuaDriver;
const FETCH_TIMEOUT_MS = readPositiveIntEnv(
  'MAKA_CUA_DRIVER_FETCH_TIMEOUT_MS',
  DEFAULT_FETCH_TIMEOUT_MS,
);

export function cuaDriverSupported(platform = process.platform) {
  return platform === 'darwin';
}

export function cuaDriverDownloadUrl(tag, asset) {
  return `https://github.com/${cua.repo}/releases/download/${tag}/${asset}`;
}

export function sha256(data) {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

export function assertPinnedCuaDriverChecksums(entry) {
  for (const field of ['archiveSha256', 'binarySha256', 'licenseSha256', 'sourceSha256']) {
    if (!SHA256_PATTERN.test(entry?.[field] ?? '')) {
      throw new Error(
        `bundled-tools.json cuaDriver.${field} must be a pinned lowercase 64-character SHA-256 digest ` +
          `(received ${JSON.stringify(entry?.[field])}).`,
      );
    }
  }
  if (entry.archiveSha256 === entry.binarySha256) {
    throw new Error(
      'bundled-tools.json must pin the cua-driver archive and extracted binary separately.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'sha256')) {
    throw new Error(
      'bundled-tools.json cuaDriver.sha256 is ambiguous; use archiveSha256 and binarySha256.',
    );
  }
  if (
    typeof entry?.expectedVersion !== 'string' ||
    typeof entry?.expectedProtocolVersion !== 'string' ||
    typeof entry?.sourceCommit !== 'string' ||
    typeof entry?.upstreamCommit !== 'string' ||
    typeof entry?.upstreamMergeCommit !== 'string' ||
    typeof entry?.cargoLockSha256 !== 'string' ||
    !Array.isArray(entry?.architectures) ||
    entry.architectures.length === 0 ||
    !['archiveSizeBytes', 'binarySizeBytes', 'licenseSizeBytes', 'sourceSizeBytes'].every(
      (field) => Number.isSafeInteger(entry?.[field]) && entry[field] > 0,
    )
  ) {
    throw new Error(
      'bundled-tools.json cuaDriver must pin version, protocol, source commits, Cargo.lock, architectures, and exact file sizes.',
    );
  }
}

function destinationPath() {
  return join(binDir, cua.binaryName);
}

function markerPath() {
  return join(binDir, '.cua-driver.json');
}

function expectedMarker() {
  return {
    version: cua.version,
    expectedVersion: cua.expectedVersion,
    expectedProtocolVersion: cua.expectedProtocolVersion,
    sourceCommit: cua.sourceCommit,
    upstreamCommit: cua.upstreamCommit,
    upstreamMergeCommit: cua.upstreamMergeCommit,
    archiveSizeBytes: cua.archiveSizeBytes,
    binarySizeBytes: cua.binarySizeBytes,
    licenseSizeBytes: cua.licenseSizeBytes,
    sourceSizeBytes: cua.sourceSizeBytes,
    archiveSha256: cua.archiveSha256,
    binarySha256: cua.binarySha256,
    licenseSha256: cua.licenseSha256,
    sourceSha256: cua.sourceSha256,
  };
}

function markerMatches(marker) {
  const expected = expectedMarker();
  return (
    marker?.version === expected.version &&
    marker?.expectedVersion === expected.expectedVersion &&
    marker?.expectedProtocolVersion === expected.expectedProtocolVersion &&
    marker?.sourceCommit === expected.sourceCommit &&
    marker?.upstreamCommit === expected.upstreamCommit &&
    marker?.upstreamMergeCommit === expected.upstreamMergeCommit &&
    marker?.archiveSizeBytes === expected.archiveSizeBytes &&
    marker?.binarySizeBytes === expected.binarySizeBytes &&
    marker?.licenseSizeBytes === expected.licenseSizeBytes &&
    marker?.sourceSizeBytes === expected.sourceSizeBytes &&
    marker?.archiveSha256 === expected.archiveSha256 &&
    marker?.binarySha256 === expected.binarySha256 &&
    marker?.licenseSha256 === expected.licenseSha256 &&
    marker?.sourceSha256 === expected.sourceSha256
  );
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer timeout in milliseconds`);
  }
  return parsed;
}

function isTimeoutError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'),
  );
}

function timeoutError(url) {
  return new Error(`Timed out downloading ${url} after ${FETCH_TIMEOUT_MS}ms`);
}

export async function downloadFileWithSha256(
  url,
  destination,
  { maxBytes, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('cua-driver download maxBytes must be a positive integer');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(url);
    throw error;
  }
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(
      `Refusing oversized cua-driver download: ${declaredLength} bytes exceeds ${maxBytes}`,
    );
  }
  if (!response.body) {
    throw new Error(`Failed to download ${url}: response body missing`);
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let completed = false;
  const file = await open(destination, 'wx', 0o600);
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `Refusing oversized cua-driver download: received more than ${maxBytes} bytes`,
        );
      }
      hash.update(chunk);
      await file.write(chunk);
    }
    completed = true;
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(url);
    throw error;
  } finally {
    await file.close();
    if (!completed) await rm(destination, { force: true });
  }
}

// Idempotency: skip the network round-trip when the pinned version + checksum
// already match the on-disk marker AND the binary is present + executable.
async function alreadyPrepared() {
  try {
    await access(destinationPath(), constants.X_OK);
    const marker = JSON.parse(await readFile(markerPath(), 'utf8'));
    if (!markerMatches(marker)) return false;
    const [binaryInfo, licenseInfo, sourceInfo] = await Promise.all([
      stat(destinationPath()),
      stat(join(licenseDir, 'LICENSE.md')),
      stat(join(licenseDir, 'SOURCE.json')),
    ]);
    if (
      binaryInfo.size !== cua.binarySizeBytes ||
      licenseInfo.size !== cua.licenseSizeBytes ||
      sourceInfo.size !== cua.sourceSizeBytes
    )
      return false;
    // Re-hash the actual binary so a corrupted/swapped file with an intact marker
    // is not silently trusted — on drift, fall through to re-download/re-verify.
    const actualBinarySha256 = sha256(await readFile(destinationPath()));
    const actualLicenseSha256 = sha256(await readFile(join(licenseDir, 'LICENSE.md')));
    const actualSourceSha256 = sha256(await readFile(join(licenseDir, 'SOURCE.json')));
    return (
      actualBinarySha256 === cua.binarySha256 &&
      actualLicenseSha256 === cua.licenseSha256 &&
      actualSourceSha256 === cua.sourceSha256
    );
  } catch {
    return false;
  }
}

export function assertMachOHeader(bytes) {
  const header = Buffer.from(bytes).subarray(0, 4);
  const magic = header.toString('hex');
  if (header.byteLength !== 4 || !MACH_O_MAGICS.has(magic)) {
    throw new Error(`cua-driver is not a recognized Mach-O binary (magic ${magic || 'missing'})`);
  }
}

export async function verifyBinaryMetadata(binaryPath, entry = cua, runCommand = execFileAsync) {
  const info = await stat(binaryPath);
  if (!info.isFile() || info.size !== entry.binarySizeBytes) {
    throw new Error(
      `Unexpected cua-driver size: expected ${entry.binarySizeBytes}, got ${info.size}`,
    );
  }
  const handle = await open(binaryPath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    assertMachOHeader(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  await runCommand('lipo', [binaryPath, '-verify_arch', ...entry.architectures]);
  await runCommand('codesign', ['--verify', '--strict', '--verbose=2', binaryPath]);
  const signature = await runCommand('codesign', ['--display', '--verbose=4', binaryPath]);
  const signatureDetails = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`;
  if (entry.signature === 'adhoc' && !/Signature=adhoc/.test(signatureDetails)) {
    throw new Error('cua-driver signature mismatch: expected an ad hoc code signature');
  }
}

export async function verifyBinaryVersion(binaryPath, entry = cua, runCommand = execFileAsync) {
  const { stdout } = await runCommand(binaryPath, ['--version']);
  if (stdout.trim() !== `cua-driver ${entry.expectedVersion}`) {
    throw new Error(
      `Unexpected cua-driver version: expected ${entry.expectedVersion}, got ${JSON.stringify(stdout.trim())}`,
    );
  }
}

export function assertSafeTarEntries(entries) {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('\\')) {
      throw new Error(`Unsafe cua-driver archive entry: ${JSON.stringify(entry)}`);
    }
  }
}

export function assertSafeTarListing(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new Error(`Unsupported cua-driver archive entry type: ${JSON.stringify(line)}`);
    }
  }
}

export function assertSourceProvenance(source, entry = cua) {
  const expected = {
    repository: entry.repo,
    upstreamTag: entry.upstreamTag,
    upstreamCommit: entry.upstreamCommit,
    sourceCommit: entry.sourceCommit,
    patchPullRequest: entry.patchPullRequest,
    cargoLockSha256: entry.cargoLockSha256,
    signature: entry.signature,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (source?.[field] !== value) {
      throw new Error(
        `cua-driver SOURCE.json ${field} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(source?.[field])}`,
      );
    }
  }
  if (
    !Array.isArray(source?.architectures) ||
    source.architectures.length !== entry.architectures.length ||
    !entry.architectures.every((arch) => source.architectures.includes(arch))
  ) {
    throw new Error('cua-driver SOURCE.json architectures do not match bundled-tools.json.');
  }
}

export async function prepareCuaDriver(targetPlatform = process.platform) {
  if (!cuaDriverSupported(targetPlatform)) {
    return { skipped: true, reason: `cua-driver is macOS-only; skipping ${targetPlatform}` };
  }
  assertPinnedCuaDriverChecksums(cua);
  if (await alreadyPrepared()) {
    return {
      skipped: true,
      reason: 'up-to-date',
      destination: destinationPath(),
      version: cua.version,
    };
  }

  // Extract the tarball to a temp dir, then copy out the single `cua-driver`
  // Mach-O. Tarball internal layout is not assumed — we locate the binary.
  const workDir = await mkdtemp(join(tmpdir(), 'maka-cua-driver-'));
  try {
    const tarPath = join(workDir, cua.asset);
    const url = cuaDriverDownloadUrl(cua.tag, cua.asset);
    const downloaded = await downloadFileWithSha256(url, tarPath, {
      maxBytes: cua.archiveSizeBytes,
    });
    if (downloaded.bytes !== cua.archiveSizeBytes) {
      throw new Error(
        `Size mismatch for ${cua.asset}: expected ${cua.archiveSizeBytes}, got ${downloaded.bytes}`,
      );
    }
    if (downloaded.sha256 !== cua.archiveSha256) {
      throw new Error(
        `Checksum mismatch for ${cua.asset}: expected ${cua.archiveSha256}, got ${downloaded.sha256}`,
      );
    }
    const listed = await execFileAsync('tar', ['-tzf', tarPath]);
    assertSafeTarEntries(listed.stdout.split('\n'));
    const verboseListing = await execFileAsync('tar', ['-tvzf', tarPath]);
    assertSafeTarListing(verboseListing.stdout.split('\n'));
    await execFileAsync('tar', ['-xzf', tarPath, '-C', workDir]);
    const { stdout } = await execFileAsync('find', [
      workDir,
      '-name',
      cua.binaryName,
      '-type',
      'f',
    ]);
    const found = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (found.length !== 1) {
      throw new Error(
        `Extracted archive ${cua.asset} must contain exactly one '${cua.binaryName}' binary (found ${found.length})`,
      );
    }

    const binaryBytes = await readFile(found[0]);
    if (binaryBytes.byteLength !== cua.binarySizeBytes) {
      throw new Error(
        `Size mismatch for extracted ${cua.binaryName}: expected ${cua.binarySizeBytes}, got ${binaryBytes.byteLength}`,
      );
    }
    const actualBinarySha256 = sha256(binaryBytes);
    if (actualBinarySha256 !== cua.binarySha256) {
      throw new Error(
        `Checksum mismatch for extracted ${cua.binaryName}: expected ${cua.binarySha256}, got ${actualBinarySha256}`,
      );
    }
    await verifyBinaryMetadata(found[0]);

    const licensePaths = await execFileAsync('find', [
      workDir,
      '-name',
      'LICENSE.md',
      '-type',
      'f',
    ]);
    const sourcePaths = await execFileAsync('find', [
      workDir,
      '-name',
      'SOURCE.json',
      '-type',
      'f',
    ]);
    const licenses = licensePaths.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const sources = sourcePaths.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (licenses.length !== 1 || sources.length !== 1) {
      throw new Error(
        `Extracted archive ${cua.asset} must contain exactly one LICENSE.md and SOURCE.json`,
      );
    }
    const licenseBytes = await readFile(licenses[0]);
    const sourceBytes = await readFile(sources[0]);
    if (licenseBytes.byteLength !== cua.licenseSizeBytes) {
      throw new Error(
        `Size mismatch for extracted cua-driver LICENSE.md: expected ${cua.licenseSizeBytes}, got ${licenseBytes.byteLength}`,
      );
    }
    if (sourceBytes.byteLength !== cua.sourceSizeBytes) {
      throw new Error(
        `Size mismatch for extracted cua-driver SOURCE.json: expected ${cua.sourceSizeBytes}, got ${sourceBytes.byteLength}`,
      );
    }
    if (sha256(licenseBytes) !== cua.licenseSha256) {
      throw new Error(`Checksum mismatch for extracted cua-driver LICENSE.md`);
    }
    if (sha256(sourceBytes) !== cua.sourceSha256) {
      throw new Error(`Checksum mismatch for extracted cua-driver SOURCE.json`);
    }
    assertSourceProvenance(JSON.parse(sourceBytes.toString('utf8')));
    await verifyBinaryVersion(found[0]);

    await mkdir(binDir, { recursive: true });
    await mkdir(licenseDir, { recursive: true });
    const destination = destinationPath();
    const marker = markerPath();
    const installId = randomUUID();
    const stagedBinary = `${destination}.${installId}.tmp`;
    const stagedMarker = `${marker}.${installId}.tmp`;
    try {
      await writeFile(stagedBinary, binaryBytes);
      await chmod(stagedBinary, 0o755);
      // Best-effort: clear the download quarantine xattr so the dev Electron process
      // can spawn it without a Gatekeeper prompt. Non-fatal if xattr is absent.
      try {
        await execFileAsync('xattr', ['-d', 'com.apple.quarantine', stagedBinary]);
      } catch {
        /* no quarantine attr — fine */
      }
      await writeFile(stagedMarker, `${JSON.stringify(expectedMarker(), null, 2)}\n`);
      await rename(stagedBinary, destination);
      await rename(stagedMarker, marker);
      await writeFile(join(licenseDir, 'LICENSE.md'), licenseBytes);
      await writeFile(join(licenseDir, 'SOURCE.json'), sourceBytes);
    } finally {
      await rm(stagedBinary, { force: true });
      await rm(stagedMarker, { force: true });
    }

    return {
      skipped: false,
      destination,
      version: cua.version,
      signatureMode: cua.signature,
      releaseSigningReady: false,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareCuaDriver();
  if (result.skipped) {
    process.stdout.write(`cua-driver: ${result.reason}\n`);
  } else {
    process.stdout.write(`Prepared cua-driver ${result.version}: ${result.destination}\n`);
  }
}
