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
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { desktopReleaseTargets } from './desktop-release-targets.mjs';
import {
  mergeDesktopUpdateFeeds,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
import { assertElfArchitecture, verifyLinuxRelease } from './verify-linux.mjs';

// The two `e_machine` values this project ships, from the ELF specification.
const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

let workingDirectory;

before(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), 'maka-linux-harness-'));
});

after(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

/**
 * A 64-byte ELF header is enough: the architecture assertion reads the magic,
 * `EI_DATA` and `e_machine`, and nothing else. Building the bytes here rather
 * than checking in a binary keeps the test readable and runs it on any host —
 * which is the point, since the packaging it guards only runs on Linux.
 */
async function writeElf(name, machine, { data = 1, magic = '\x7fELF' } = {}) {
  const header = Buffer.alloc(64);
  header.write(magic, 0, 'latin1');
  header[4] = 2; // EI_CLASS: ELFCLASS64
  header[5] = data; // EI_DATA: 1 little-endian, 2 big-endian
  header[6] = 1; // EI_VERSION
  header.writeUInt16LE(2, 16); // e_type: ET_EXEC
  if (data === 1) header.writeUInt16LE(machine, 18);
  else header.writeUInt16BE(machine, 18);
  const path = join(workingDirectory, name);
  await writeFile(path, header);
  return path;
}

test('the architecture assertion accepts a binary built for the target', async () => {
  await assertElfArchitecture(await writeElf('x64.node', EM_X86_64), 'x64');
  await assertElfArchitecture(await writeElf('arm64.node', EM_AARCH64), 'arm64');
});

test('the architecture assertion rejects the other architecture', async () => {
  // The failure this exists for: a runner that cross-built the Runtime Host
  // peer produces a package that installs and then dies at launch.
  const path = await writeElf('wrong.node', EM_X86_64);
  await assert.rejects(
    () => assertElfArchitecture(path, 'arm64'),
    /is built for ELF machine 0x3e, not arm64/u,
  );
});

test('the architecture assertion rejects a file that is not ELF', async () => {
  const path = join(workingDirectory, 'not-elf.node');
  await writeFile(path, 'this is not a binary at all, it is text\n');
  await assert.rejects(() => assertElfArchitecture(path, 'x64'), /is not an ELF binary/u);
});

test('the architecture assertion rejects a truncated header', async () => {
  const path = join(workingDirectory, 'truncated.node');
  await writeFile(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await assert.rejects(() => assertElfArchitecture(path, 'x64'), /is not an ELF binary/u);
});

test('the architecture assertion refuses to read a big-endian header', async () => {
  // Reading `e_machine` little-endian out of a big-endian file compares
  // garbage, so the mismatch has to be named rather than guessed at.
  const path = await writeElf('big-endian.node', EM_X86_64, { data: 2 });
  await assert.rejects(
    () => assertElfArchitecture(path, 'x64'),
    /is not a little-endian ELF binary/u,
  );
});

const FEED_VERSION = '9.9.9';

/**
 * The shape `package:linux` leaves behind: two payloads from two
 * electron-builder runs, each run's own single-payload feed, and the merged feed
 * `mergeDesktopUpdateFeeds` writes out of the two. The merge is the production
 * one, so what is verified below is the merge and the verifier together — a
 * hand-written merged document would only ever prove the verifier. The payload
 * bytes are written here and the digests taken from them, so a test that drifts
 * one field drifts it away from a feed that was otherwise exact.
 */
async function stageLinuxRelease(name, { nightly = false, drift } = {}) {
  const target = desktopReleaseTargets(FEED_VERSION, { nightly }).find(
    (entry) => entry.name === 'linux-x64',
  );
  const directory = join(workingDirectory, name);
  await mkdir(directory, { recursive: true });
  const sourcePaths = [];
  for (const payload of target.advertised) {
    const bytes = Buffer.from(`${payload} payload bytes\n`);
    await writeFile(join(directory, payload), bytes);
    // Each electron-builder run rewrites the feed knowing only its own payload;
    // `package:linux` moves the first aside under this suffix and merges it back.
    const file = {
      url: payload,
      sha512: createHash('sha512').update(bytes).digest('base64'),
      size: bytes.length,
    };
    const sourcePath = join(directory, `${target.feed}.${sourcePaths.length}`);
    await writeFile(
      sourcePath,
      feedDocument({
        version: FEED_VERSION,
        files: [file],
        path: file.url,
        sha512: file.sha512,
        releaseDate: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );
    sourcePaths.push(sourcePath);
  }
  const outputPath = join(directory, target.feed);
  const merged = await mergeDesktopUpdateFeeds({ sourcePaths, outputPath });
  await Promise.all(sourcePaths.map((path) => rm(path)));
  // Drift is applied to what the merge produced, so each rejection below names a
  // field of a real merged document rather than of a fabricated one.
  if (drift) {
    await writeFile(outputPath, feedDocument(drift(merged)), 'utf8');
  }
  return { directory, target };
}

/** electron-builder's feed layout, written by hand so this suite stays on node builtins. */
function feedDocument(feed) {
  const lines = [`version: ${feed.version}`, 'files:'];
  for (const file of feed.files) {
    lines.push(`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`);
  }
  lines.push(`path: ${feed.path}`, `sha512: ${feed.sha512}`, `releaseDate: '${feed.releaseDate}'`);
  return `${lines.join('\n')}\n`;
}

function verifyStagedFeed({ directory, target }) {
  return verifyDesktopUpdateArtifacts({
    directory,
    metadataName: target.feed,
    version: FEED_VERSION,
    artifactNames: target.advertised,
  });
}

test('the merged Linux feed offers both distributables', async () => {
  // The AppImage and the deb are built by separate electron-builder runs, the
  // second of which overwrites the first's feed; only the merge puts both in
  // one document, and until this ran nothing opened the merged bytes before
  // publication.
  const staged = await stageLinuxRelease('merged');
  const { metadata } = await verifyStagedFeed(staged);
  assert.deepEqual(
    metadata.files.map((file) => file.url).sort(),
    [...staged.target.advertised].sort(),
  );
});

test('the Nightly merged feed is read under its own name', async () => {
  // The Nightly publishes the same two payloads through `dev-linux.yml`, so a
  // verifier that only ever looked for `latest-linux.yml` would check nothing
  // there.
  const staged = await stageLinuxRelease('merged-nightly', { nightly: true });
  assert.equal(staged.target.feed, 'dev-linux.yml');
  await verifyStagedFeed(staged);
});

test('a merged feed that lost a payload is rejected', async () => {
  // The exact damage the merge can do: the deb's own feed contributes nothing
  // and the AppImage's document survives alone, offering deb users no update.
  const staged = await stageLinuxRelease('dropped-payload', {
    drift: (feed) => ({ ...feed, files: feed.files.slice(0, 1) }),
  });
  await assert.rejects(() => verifyStagedFeed(staged), /advertises \[/u);
});

test('a merged feed whose digest belongs to another payload is rejected', async () => {
  // `path` and the top-level `sha512` are the primary payload's identity; the
  // merge keeps the first document's, so pointing `path` at the other file
  // leaves an updater verifying the deb against the AppImage's digest.
  const staged = await stageLinuxRelease('mismatched-primary', {
    drift: (feed) => ({ ...feed, path: feed.files[1].url }),
  });
  await assert.rejects(() => verifyStagedFeed(staged), /inconsistent payload identity/u);
});

test('a merged feed carrying a stale digest is rejected', async () => {
  const staged = await stageLinuxRelease('stale-digest', {
    drift: (feed) => ({
      ...feed,
      files: [feed.files[0], { ...feed.files[1], sha512: createHash('sha512').digest('base64') }],
    }),
  });
  await assert.rejects(() => verifyStagedFeed(staged), /sha512 does not match/u);
});

test('a merged feed carrying a stale size is rejected', async () => {
  const staged = await stageLinuxRelease('stale-size', {
    drift: (feed) => ({
      ...feed,
      files: [feed.files[0], { ...feed.files[1], size: feed.files[1].size + 1 }],
    }),
  });
  await assert.rejects(() => verifyStagedFeed(staged), /records .* size/u);
});

test('Linux verification refuses to run anywhere else', async () => {
  // The distributables only exist on the runner that built them, so running
  // this elsewhere would otherwise fail later and less clearly.
  await assert.rejects(() => verifyLinuxRelease('x64', { platform: 'darwin' }), /requires Linux/u);
});
