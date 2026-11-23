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

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Domain separator matching third-party/nsh/crates/nsh-updater/src/lib.rs. */
const MANIFEST_CONTEXT = Buffer.from('nsh-updater-manifest\0', 'utf8');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Map from nsh-updater platform key to the nightly update archive filename. */
export const UPDATER_ARCHIVE_MAP = {
  'macos-aarch64': 'Maka-nightly-macos-arm64.tar.gz',
  'linux-x86_64': 'Maka-nightly-linux-x64.tar.gz',
  'linux-aarch64': 'Maka-nightly-linux-arm64.tar.gz',
  'windows-x86_64': 'Maka-nightly-windows-x64.zip',
};

const METADATA_FILES = new Set([
  'SHA256SUMS.txt',
  'latest.json',
  'latest.json.sig',
  'RELEASE_NOTES.md',
  'nightly-meta.json',
]);

export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: pubDer.subarray(pubDer.length - 32).toString('base64'),
    secretKey: privDer.subarray(privDer.length - 32).toString('base64'),
  };
}

function decodeKey32(base64, label) {
  const raw = Buffer.from(base64.trim(), 'base64');
  if (raw.length !== 32) {
    throw new Error(label + ' must be 32 raw Ed25519 bytes encoded as base64');
  }
  return raw;
}

export function derivePublicKey(secretKeyBase64) {
  const seed = decodeKey32(secretKeyBase64, 'secretKey');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return pubDer.subarray(pubDer.length - 32).toString('base64');
}

export function signManifest(secretKeyBase64, manifestBytes) {
  const seed = decodeKey32(secretKeyBase64, 'secretKey');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const payload = Buffer.concat([MANIFEST_CONTEXT, Buffer.from(manifestBytes)]);
  return cryptoSign(null, payload, privateKey).toString('base64');
}

export function verifyManifest(publicKeyBase64, manifestBytes, signatureBase64) {
  const pub = decodeKey32(publicKeyBase64, 'publicKey');
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, pub]),
    format: 'der',
    type: 'spki',
  });
  const payload = Buffer.concat([MANIFEST_CONTEXT, Buffer.from(manifestBytes)]);
  const sig = Buffer.from(signatureBase64.trim(), 'base64');
  return cryptoVerify(null, payload, publicKey, sig);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function renderReleaseNotes({
  version,
  commit,
  buildDate,
  repo = 'apache/maka',
  disclaimer,
  extraNotes = '',
  assets = [],
  previous = null,
  npmPublished = false,
}) {
  const shortSha = commit.slice(0, 12);
  const baseUrl = 'https://github.com/' + repo + '/releases/download/nightly';
  const out = [
    '> [!WARNING]',
    '> **UNOFFICIAL DEVELOPER NIGHTLY BUILD — NOT AN APACHE SOFTWARE FOUNDATION RELEASE**',
    '>',
    '> This pre-release provides automated pre-built binaries strictly for **developer testing and evaluation**.',
    '> It is **NOT** an official Apache Software Foundation (ASF) release, has **NOT** been approved by an ASF release vote, and may be unstable.',
    '',
    '## Build Info',
    '',
    '- **Version**: `' + version + '`',
    '- **Commit**: [' + shortSha + '](https://github.com/' + repo + '/commit/' + commit + ')',
    '- **Built (UTC)**: ' + buildDate,
    '- **Update Channel**: `nightly` (auto-updates only follow `nightly`, never stable releases)',
  ];

  if (extraNotes && extraNotes.trim()) {
    out.push('', '## Notes', '', extraNotes.trim());
  }

  out.push(
    '',
    '## Install (Current Nightly)',
    '',
    '| Platform | Installer / Package | Notes |',
    '| --- | --- | --- |',
  );

  const assetSet = new Set(assets);
  if (assetSet.has('Maka-nightly-macos-arm64.dmg')) {
    out.push(
      '| macOS (Apple Silicon) | [Maka-nightly-macos-arm64.dmg](' +
        baseUrl +
        '/Maka-nightly-macos-arm64.dmg) | Drag `Maka.app` to Applications (self-contained desktop + CLI) |',
    );
  }
  if (assetSet.has('Maka-nightly-windows-x64-setup.exe')) {
    out.push(
      '| Windows (x64) | [Maka-nightly-windows-x64-setup.exe](' +
        baseUrl +
        '/Maka-nightly-windows-x64-setup.exe) | Per-user installer (no admin required, adds `maka` to user PATH) |',
    );
  } else if (assetSet.has('Maka-nightly-windows-x64.zip')) {
    out.push(
      '| Windows (x64) | [Maka-nightly-windows-x64.zip](' +
        baseUrl +
        '/Maka-nightly-windows-x64.zip) | Portable archive |',
    );
  }
  if (assetSet.has('Maka-nightly-linux-x64.tar.gz')) {
    out.push(
      '| Linux (x64) | [Maka-nightly-linux-x64.tar.gz](' +
        baseUrl +
        '/Maka-nightly-linux-x64.tar.gz) | glibc 2.28+ archive; run `./maka/install.sh` after extracting |',
    );
  }
  if (assetSet.has('Maka-nightly-linux-arm64.tar.gz')) {
    out.push(
      '| Linux (arm64) | [Maka-nightly-linux-arm64.tar.gz](' +
        baseUrl +
        '/Maka-nightly-linux-arm64.tar.gz) | glibc 2.28+ archive; run `./maka/install.sh` after extracting |',
    );
  }

  if (assetSet.has('install.sh')) {
    out.push(
      '',
      'One-line install on Linux / macOS:',
      '',
      '```sh',
      'curl -fsSL ' + baseUrl + '/install.sh | sh',
      '```',
    );
  }

  if (npmPublished) {
    out.push(
      '',
      'Install via npm (unofficial `@nightly` tag — published with this build):',
      '',
      '```sh',
      'npm install --global @maka-agent/cli@' + version,
      '# or using the alias package:',
      'npm install --global maka-agent@' + version,
      '```',
    );
  }

  if (previous && (previous.version || previous.commit || (previous.assets ?? []).length > 0)) {
    const prevBase = 'https://github.com/' + repo + '/releases/download/nightly-previous';
    out.push(
      '',
      '## Previous Nightly',
      '',
      'The immediately preceding nightly build is retained under the [`nightly-previous`](https://github.com/' +
        repo +
        '/releases/tag/nightly-previous) pre-release in case you need to roll back:',
      '',
    );
    if (previous.version) out.push('- **Version**: `' + previous.version + '`');
    if (previous.commit) {
      out.push(
        '- **Commit**: [' +
          previous.commit.slice(0, 12) +
          '](https://github.com/' +
          repo +
          '/commit/' +
          previous.commit +
          ')',
      );
    }
    if (previous.buildDate) out.push('- **Built (UTC)**: ' + previous.buildDate);
    const prevDownloads = (previous.assets ?? []).filter(
      (name) => !METADATA_FILES.has(name) && name !== 'install.sh',
    );
    if (prevDownloads.length > 0) {
      out.push('', 'Downloads:');
      for (const name of prevDownloads.sort()) {
        out.push('- [' + name + '](' + prevBase + '/' + name + ')');
      }
      if ((previous.assets ?? []).includes('SHA256SUMS.txt')) {
        out.push('- [SHA256SUMS.txt](' + prevBase + '/SHA256SUMS.txt)');
      }
    }
  }

  out.push('', '## Apache Incubator Disclaimer', '', disclaimer.trim());
  return out.join('\n') + '\n';
}

export async function generateNightlyMetadata({
  directory,
  version,
  commit,
  buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  repo = 'apache/maka',
  secretKey = process.env.MAKA_UPDATE_SIGNING_KEY,
  expectedPublicKey = process.env.MAKA_UPDATE_PUBLIC_KEY,
  requireSignature = false,
  npmPublished = false,
  extraNotes = '',
  previous = null,
  notesOutput = null,
  repositoryRoot = root,
}) {
  const dir = resolve(directory);
  const entries = (await readdir(dir)).filter((name) => !METADATA_FILES.has(name)).sort();

  const digests = new Map();
  const sizes = new Map();
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full);
    if (!info.isFile()) continue;
    digests.set(name, await sha256File(full));
    sizes.set(name, info.size);
  }

  const checksumLines = [...digests.entries()].map(([name, hex]) => hex + '  ' + name);
  await writeFile(join(dir, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');

  const platforms = {};
  for (const [platformKey, fileName] of Object.entries(UPDATER_ARCHIVE_MAP)) {
    if (!digests.has(fileName)) continue;
    platforms[platformKey] = {
      url: fileName,
      sha256: digests.get(fileName),
      size: sizes.get(fileName),
    };
  }

  const manifest = {
    id: 'org.apache.maka.desktop',
    version,
    notes:
      'Unofficial developer nightly build ' +
      version +
      ' (' +
      commit.slice(0, 12) +
      '). Not an official Apache Software Foundation release.',
    platforms,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(join(dir, 'latest.json'), manifestBytes);

  const trimmedSecret = secretKey?.trim() ?? '';
  const trimmedExpectedPub = expectedPublicKey?.trim() ?? '';
  if (requireSignature && !trimmedSecret) {
    throw new Error('MAKA_UPDATE_SIGNING_KEY is required to sign nightly latest.json');
  }
  if (requireSignature && !trimmedExpectedPub) {
    throw new Error(
      'MAKA_UPDATE_PUBLIC_KEY is required to verify latest.json.sig matches the compiled binary key',
    );
  }

  let signed = false;
  if (trimmedSecret) {
    const signature = signManifest(trimmedSecret, manifestBytes);
    const derivedPublicKey = derivePublicKey(trimmedSecret);
    if (trimmedExpectedPub && trimmedExpectedPub !== derivedPublicKey) {
      throw new Error('MAKA_UPDATE_SIGNING_KEY does not match the compiled MAKA_UPDATE_PUBLIC_KEY');
    }
    const verifyKey = trimmedExpectedPub || derivedPublicKey;
    if (!verifyManifest(verifyKey, manifestBytes, signature)) {
      throw new Error('Ed25519 manifest signature verification failed');
    }
    await writeFile(join(dir, 'latest.json.sig'), signature + '\n', 'utf8');
    signed = true;
  }

  const disclaimer = await readFile(join(repositoryRoot, 'DISCLAIMER'), 'utf8');
  const notes = renderReleaseNotes({
    version,
    commit,
    buildDate,
    repo,
    disclaimer,
    extraNotes,
    assets: [...digests.keys()],
    previous,
    npmPublished,
  });
  await writeFile(resolve(notesOutput ?? join(dir, 'RELEASE_NOTES.md')), notes, 'utf8');

  const publishedAssets = [
    ...digests.keys(),
    'SHA256SUMS.txt',
    'latest.json',
    ...(signed ? ['latest.json.sig'] : []),
  ].sort();
  const meta = {
    version,
    commit,
    buildDate,
    assets: publishedAssets,
  };
  await writeFile(join(dir, 'nightly-meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  return { manifest, signed, assets: publishedAssets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'keygen') {
    console.log(JSON.stringify(generateKeypair(), null, 2));
  } else if (command === 'generate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        dir: { type: 'string' },
        version: { type: 'string' },
        commit: { type: 'string' },
        'build-date': { type: 'string' },
        repo: { type: 'string' },
        notes: { type: 'string' },
        'notes-out': { type: 'string' },
        'previous-meta': { type: 'string' },
        'expected-public-key': { type: 'string' },
        'require-signature': { type: 'boolean' },
        'npm-published': { type: 'boolean' },
      },
    });
    if (!values.dir || !values.version || !values.commit) {
      throw new Error(
        'usage: nightly-manifest.mjs generate --dir <dir> --version <ver> --commit <sha>',
      );
    }
    let previous = null;
    if (values['previous-meta']) {
      try {
        previous = JSON.parse(await readFile(values['previous-meta'], 'utf8'));
      } catch {
        previous = null;
      }
    }
    const result = await generateNightlyMetadata({
      directory: values.dir,
      version: values.version,
      commit: values.commit,
      buildDate: values['build-date'],
      repo: values.repo ?? 'apache/maka',
      extraNotes: values.notes ?? '',
      notesOutput: values['notes-out'] ?? null,
      expectedPublicKey: values['expected-public-key'] ?? process.env.MAKA_UPDATE_PUBLIC_KEY,
      requireSignature: Boolean(values['require-signature']),
      npmPublished: Boolean(values['npm-published']),
      previous,
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error('usage: nightly-manifest.mjs <keygen|generate> ...');
  }
}
