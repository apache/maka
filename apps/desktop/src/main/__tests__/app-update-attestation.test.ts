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

import type { Bundle } from '@sigstore/bundle';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  desktopDiagnosticUpdateChannel,
  desktopUpdateChannelFromManifest,
  verifyDownloadedUpdateAttestation,
} from '../app-update-attestation.js';

const require = createRequire(import.meta.url);

function assertElectronVerification(script: string, failureMessage: string): void {
  const verification = spawnSync(require('electron') as string, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(
    verification.status,
    0,
    `${failureMessage}:\n${verification.stderr || verification.stdout}`,
  );
}

function provenanceBundle(name: string, sha256: string): Bundle {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name, digest: { sha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {},
  };
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      content: undefined,
      tlogEntries: [],
      timestampVerificationData: undefined,
    },
    content: {
      $case: 'dsseEnvelope',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(statement)),
        signatures: [],
      },
    },
  } as unknown as Bundle;
}

function serializedBundle(name: string, sha256: string): Buffer {
  const bundle = provenanceBundle(name, sha256);
  return Buffer.from(JSON.stringify({
    mediaType: bundle.mediaType,
    verificationMaterial: {
      certificate: { rawBytes: Buffer.from('fixture certificate').toString('base64') },
      tlogEntries: [],
    },
    dsseEnvelope: {
      payloadType: bundle.content.$case === 'dsseEnvelope'
        ? bundle.content.dsseEnvelope.payloadType
        : '',
      payload: bundle.content.$case === 'dsseEnvelope'
        ? Buffer.from(bundle.content.dsseEnvelope.payload).toString('base64')
        : '',
      signatures: [{ sig: Buffer.from('fixture signature').toString('base64') }],
    },
  }));
}

const FIXTURE_VERSION = '1.2.3';

/**
 * The payload names the release descriptor advertises, so the accept case runs
 * against the artifacts a real feed offers rather than invented ones.
 */
const { desktopReleaseTargets } = (await import(
  new URL('../../../../../scripts/desktop-release-targets.mjs', import.meta.url).href
)) as {
  desktopReleaseTargets: (
    version: string,
    options: { nightly: boolean },
  ) => { advertised: string[] }[];
};

const ADVERTISED_PAYLOADS = desktopReleaseTargets(FIXTURE_VERSION, { nightly: false }).flatMap(
  (target) => target.advertised,
);

/** One cached download, named by the updater after the feed entry it chose. */
async function stageDownload(
  directory: string,
  name: string,
): Promise<{ downloadedFile: string; digest: string }> {
  const downloadedFile = join(directory, name);
  const bytes = Buffer.from(`update bytes for ${name}`);
  await writeFile(downloadedFile, bytes);
  return { downloadedFile, digest: createHash('sha256').update(bytes).digest('hex') };
}

function feedFiles(names: readonly string[]): { url: string }[] {
  return names.map((name) => ({ url: name }));
}

/** The platform that installs an advertised payload, by the name it carries. */
function installingPlatform(name: string): NodeJS.Platform {
  if (name.includes('-mac-')) return 'darwin';
  if (name.includes('-win-')) return 'win32';
  return 'linux';
}

test('download verification accepts every payload the release descriptor advertises', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const name of ADVERTISED_PAYLOADS) {
    const { downloadedFile, digest } = await stageDownload(directory, name);
    await verifyDownloadedUpdateAttestation({
      downloadedFile,
      version: FIXTURE_VERSION,
      platform: installingPlatform(name),
      // A feed lists sibling payloads too; only the downloaded one is verified.
      files: feedFiles(ADVERTISED_PAYLOADS),
      trustRootCacheDirectory: join(directory, 'trust'),
      fetchBundle: async () => serializedBundle(name, digest),
      verifyBundle: async () => {},
    });
  }
});

test('download verification follows the chosen payload, not the running architecture', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-rosetta-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // An x64 macOS build under Rosetta reports process.arch 'x64' while
  // electron-updater downloads the arm64 ZIP.
  const name = `Maka-${FIXTURE_VERSION}-mac-arm64.zip`;
  const { downloadedFile, digest } = await stageDownload(directory, name);

  await verifyDownloadedUpdateAttestation({
    downloadedFile,
    version: FIXTURE_VERSION,
    platform: 'darwin',
    files: feedFiles([name, `Maka-${FIXTURE_VERSION}-mac-x64.zip`]),
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async () => serializedBundle(name, digest),
    verifyBundle: async () => {},
  });
});

test('download verification rejects a payload the feed, the version or the attestation disowns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-attestation-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `Maka-${FIXTURE_VERSION}-mac-arm64.zip`;
  const { downloadedFile, digest } = await stageDownload(directory, name);
  const options = {
    downloadedFile,
    version: FIXTURE_VERSION,
    platform: 'darwin' as NodeJS.Platform,
    files: feedFiles([name]),
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async () => serializedBundle(name, digest),
    verifyBundle: async () => {},
  };

  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      files: feedFiles([`Maka-${FIXTURE_VERSION}-win-x64.exe`]),
    }),
    /not a payload the update feed offered/u,
  );

  // A legacy feed lists no payloads at all, so nothing it served is verifiable.
  await assert.rejects(
    verifyDownloadedUpdateAttestation({ ...options, files: undefined }),
    /not a payload the update feed offered/u,
  );

  // Same version, same extension, but not a desktop package: the CLI archive.
  const cliArchive = await stageDownload(directory, `Maka-${FIXTURE_VERSION}-cli-mac-arm64.zip`);
  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      downloadedFile: cliArchive.downloadedFile,
      files: feedFiles([`Maka-${FIXTURE_VERSION}-cli-mac-arm64.zip`]),
      fetchBundle: async () =>
        serializedBundle(`Maka-${FIXTURE_VERSION}-cli-mac-arm64.zip`, cliArchive.digest),
    }),
    /not a desktop package darwin installs/u,
  );

  // Another platform's package, offered to a Windows build by a tampered feed.
  const debian = await stageDownload(directory, `Maka-${FIXTURE_VERSION}-linux-amd64.deb`);
  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      platform: 'win32',
      downloadedFile: debian.downloadedFile,
      files: feedFiles([`Maka-${FIXTURE_VERSION}-linux-amd64.deb`]),
      fetchBundle: async () =>
        serializedBundle(`Maka-${FIXTURE_VERSION}-linux-amd64.deb`, debian.digest),
    }),
    /not a desktop package win32 installs/u,
  );

  const stale = await stageDownload(directory, `Maka-1.2.2-mac-arm64.zip`);
  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      downloadedFile: stale.downloadedFile,
      files: feedFiles([`Maka-1.2.2-mac-arm64.zip`]),
      fetchBundle: async () => serializedBundle(`Maka-1.2.2-mac-arm64.zip`, stale.digest),
    }),
    /does not belong to version 1\.2\.3/u,
  );

  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      fetchBundle: async () =>
        serializedBundle(name, createHash('sha256').update('other bytes').digest('hex')),
    }),
    /does not identify/u,
  );

  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      verifyBundle: () => {
        throw new Error('untrusted workflow identity');
      },
    }),
    /untrusted workflow identity/u,
  );
});

test('nightly verification fetches provenance from the versioned GitHub Release asset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-nightly-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '0.2.0-dev.20260829.42';
  const name = `Maka-${version}-mac-arm64.zip`;
  const { downloadedFile, digest } = await stageDownload(directory, name);
  let fetchedUrl = '';

  await verifyDownloadedUpdateAttestation({
    channel: 'nightly',
    downloadedFile,
    version,
    platform: 'darwin',
    files: feedFiles([name]),
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async (url) => {
      fetchedUrl = url;
      return serializedBundle(name, digest);
    },
    verifyBundle: async () => {},
  });

  assert.equal(
    fetchedUrl,
    `https://github.com/apache/maka/releases/download/v${version}/Maka-${version}-attestation.sigstore.json`,
  );
});

test('packaged update trust accepts only an explicit release or nightly channel', () => {
  assert.equal(desktopUpdateChannelFromManifest({ makaUpdateChannel: 'release' }), 'release');
  assert.equal(desktopUpdateChannelFromManifest({ makaUpdateChannel: 'nightly' }), 'nightly');
  assert.throws(
    () => desktopUpdateChannelFromManifest({ makaUpdateChannel: 'preview' }),
    /does not declare a trusted update channel/u,
  );
});

test('a diagnostic report names the channel it can prove, and admits when it cannot', async () => {
  const appPath = await mkdtemp(join(tmpdir(), 'maka-channel-'));
  const channelOf = (isPackaged: boolean) => desktopDiagnosticUpdateChannel({ isPackaged, appPath });
  try {
    // Packaged: the manifest electron-builder stamped is the authority, and the
    // two feeds must come back distinct — they carry different signers.
    await writeFile(join(appPath, 'package.json'), JSON.stringify({ makaUpdateChannel: 'nightly' }));
    assert.equal(channelOf(true), 'nightly');
    await writeFile(join(appPath, 'package.json'), JSON.stringify({ makaUpdateChannel: 'release' }));
    assert.equal(channelOf(true), 'release');

    // A checkout follows no feed, and never reads the manifest: the `release`
    // value the updater falls back to is a placeholder, not a fact.
    assert.equal(channelOf(false), 'dev');

    // Unlike the strict parser, this one must not throw — the report has to
    // copy even when the manifest is the thing that is broken.
    await writeFile(join(appPath, 'package.json'), '{ not json');
    assert.equal(channelOf(true), 'unknown');
    await writeFile(join(appPath, 'package.json'), JSON.stringify({ makaUpdateChannel: 'preview' }));
    assert.equal(channelOf(true), 'unknown');
    await rm(join(appPath, 'package.json'));
    assert.equal(channelOf(true), 'unknown');
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test('TUF verifies ECDSA without breaking Ed25519 in the packaged Electron runtime', () => {
  assertElectronVerification(
    String.raw`
        const { generateKeyPairSync, sign } = require('node:crypto');
        const { dirname, join } = require('node:path');
        const modelsEntry = require.resolve('@tufjs/models');
        const { canonicalize } = require('@tufjs/canonical-json');
        const { verifySignature } = require(join(dirname(modelsEntry), 'utils', 'verify.js'));
        const metadata = { _type: 'root', expires: '2030-01-01T00:00:00Z', version: 1 };
        const data = Buffer.from(canonicalize(metadata));
        for (const { type, options, algorithm } of [
          { type: 'ec', options: { namedCurve: 'prime256v1' }, algorithm: 'sha256' },
          { type: 'ed25519', options: {}, algorithm: null },
        ]) {
          const { privateKey, publicKey } = generateKeyPairSync(type, options);
          const signature = sign(algorithm, data, privateKey).toString('hex');
          if (!verifySignature(metadata, { key: publicKey }, signature)) process.exit(1);
        }
      `,
    'Electron TUF verification failed',
  );
});

test('Sigstore verifies ECDSA without breaking Ed25519 in the packaged Electron runtime', () => {
  assertElectronVerification(
    String.raw`
        const { generateKeyPairSync, sign } = require('node:crypto');
        const { crypto } = require('@sigstore/core');
        const data = Buffer.from('signed update metadata');
        for (const { type, options, algorithm } of [
          { type: 'ec', options: { namedCurve: 'prime256v1' }, algorithm: 'sha256' },
          { type: 'ed25519', options: {}, algorithm: null },
        ]) {
          const { privateKey, publicKey } = generateKeyPairSync(type, options);
          const signature = sign(algorithm, data, privateKey);
          if (!crypto.verify(data, publicKey, signature)) process.exit(1);
        }
        if (crypto.verify(data, 'not a public key', Buffer.alloc(0))) process.exit(1);
      `,
    'Electron Sigstore verification failed',
  );
});
