#!/usr/bin/env node
// Release gate: assert the cua-driver binary is present, non-empty, executable,
// and matches the pinned checksum before packaging. Analogous to
// This check is macOS-only and is a no-op elsewhere.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertPinnedCuaDriverChecksums,
  assertSourceProvenance,
  cuaDriverSupported,
  verifyBinaryMetadata,
  verifyBinaryVersion,
} from './prepare-cua-driver.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const binDir = join(repoRoot, 'apps', 'desktop', 'resources', 'bin');
const licenseDir = join(repoRoot, 'apps', 'desktop', 'resources', 'licenses', 'cua-driver');
const execFileAsync = promisify(execFile);

export async function checkCuaDriverBundle(targetPlatform = process.platform) {
  if (!cuaDriverSupported(targetPlatform)) {
    return { skipped: true };
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cua = manifest.cuaDriver;
  assertPinnedCuaDriverChecksums(cua);
  const binaryPath = join(binDir, cua.binaryName);
  const markerPath = join(binDir, '.cua-driver.json');
  const licensePath = join(licenseDir, 'LICENSE.md');
  const sourcePath = join(licenseDir, 'SOURCE.json');

  try {
    await access(binaryPath, constants.R_OK);
  } catch {
    throw new Error(
      `cua-driver bundle missing (${cua.asset}). Run \`npm run prepare:cua-driver\` before packaging.`,
    );
  }
  const info = await stat(binaryPath);
  if (!info.isFile() || info.size !== cua.binarySizeBytes) {
    throw new Error(
      `cua-driver bundle size mismatch: expected ${cua.binarySizeBytes}, got ${info.size}: ${binaryPath}`,
    );
  }
  await access(binaryPath, constants.X_OK);

  // Authoritative check: re-hash the actual binary bytes and fail closed unless
  // they match the pinned checksum. The plaintext marker is trusted only as a
  // secondary signal (below), never on its own.
  const bytes = await readFile(binaryPath);
  const actualBinarySha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualBinarySha256 !== cua.binarySha256) {
    throw new Error(
      `cua-driver bundle checksum mismatch: expected ${cua.binarySha256}, got ${actualBinarySha256} (${binaryPath}). ` +
        `Re-run \`npm run prepare:cua-driver\`.`,
    );
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw new Error(
      `cua-driver bundle marker is missing or invalid: ${markerPath}. ` +
        `Re-run \`npm run prepare:cua-driver\`.`,
    );
  }
  if (
    marker.version !== cua.version ||
    marker.expectedVersion !== cua.expectedVersion ||
    marker.expectedProtocolVersion !== cua.expectedProtocolVersion ||
    marker.sourceCommit !== cua.sourceCommit ||
    marker.upstreamCommit !== cua.upstreamCommit ||
    marker.upstreamMergeCommit !== cua.upstreamMergeCommit ||
    marker.archiveSizeBytes !== cua.archiveSizeBytes ||
    marker.binarySizeBytes !== cua.binarySizeBytes ||
    marker.licenseSizeBytes !== cua.licenseSizeBytes ||
    marker.sourceSizeBytes !== cua.sourceSizeBytes ||
    marker.archiveSha256 !== cua.archiveSha256 ||
    marker.binarySha256 !== cua.binarySha256 ||
    marker.licenseSha256 !== cua.licenseSha256 ||
    marker.sourceSha256 !== cua.sourceSha256
  ) {
    throw new Error(
      `cua-driver bundle marker mismatch: manifest ${cua.version}/${cua.archiveSha256}/${cua.binarySha256}, ` +
        `on disk ${marker.version}/${marker.archiveSha256}/${marker.binarySha256}. Re-run \`npm run prepare:cua-driver\`.`,
    );
  }

  const licenseBytes = await readFile(licensePath);
  const sourceBytes = await readFile(sourcePath);
  if (
    licenseBytes.byteLength !== cua.licenseSizeBytes ||
    sourceBytes.byteLength !== cua.sourceSizeBytes
  ) {
    throw new Error(
      'cua-driver license/provenance size mismatch. Re-run `npm run prepare:cua-driver`.',
    );
  }
  const actualLicenseSha256 = createHash('sha256').update(licenseBytes).digest('hex');
  const actualSourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  if (actualLicenseSha256 !== cua.licenseSha256 || actualSourceSha256 !== cua.sourceSha256) {
    throw new Error(
      'cua-driver license/provenance checksum mismatch. Re-run `npm run prepare:cua-driver`.',
    );
  }
  assertSourceProvenance(JSON.parse(sourceBytes.toString('utf8')), cua);
  await verifyBinaryMetadata(binaryPath, cua, execFileAsync);
  await verifyBinaryVersion(binaryPath, cua, execFileAsync);
  return {
    skipped: false,
    binaryPath,
    version: cua.version,
    signatureMode: cua.signature,
    releaseSigningReady: false,
  };
}

export function cuaDriverDistributionBlockers(entry) {
  const blockers = [];
  if (entry.signature !== 'developer-id') blockers.push('developer_id_signature');
  if (entry.notarization !== 'verified') blockers.push('notarization');
  if (entry.artifactAttestation !== 'verified') blockers.push('artifact_attestation');
  if (entry.buildProvenance !== 'verified') blockers.push('build_provenance');
  if (entry.thirdPartyNotices !== 'verified') blockers.push('third_party_notices');
  if (entry.distributionReady !== true) blockers.push('distribution_ready');
  return blockers;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkCuaDriverBundle();
  if (result.skipped) {
    process.stdout.write('cua-driver bundle check skipped (non-macOS)\n');
  } else {
    process.stdout.write(
      `Verified pinned cua-driver ${result.version} artifact integrity: ${result.binaryPath}\n`,
    );
  }
}
