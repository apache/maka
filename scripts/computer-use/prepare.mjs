#!/usr/bin/env node
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

// Build the maka-cu executor from source and pin the result.
//
// cua-driver arrived as a signed upstream release, so preparing it meant
// downloading a tarball and checking it against a digest someone else produced.
// maka-cu is ours: there is no third party to download from, and the artifact
// that matters is the one this machine just built. So this script builds it,
// records what it built, and writes both into apps/desktop/bundled-tools.json —
// the same manifest the host reads, so the running app can only ever spawn a
// binary whose bytes match the ones recorded here.
//
// Nothing about this is a substitute for signing. `distributionReady` stays
// false until a notarized artifact exists, and the host refuses to use an
// unready entry in a packaged build — a development build is the only place
// this binary runs.
//
//   node scripts/computer-use.mjs prepare
//   MAKA_CU_SOURCE=/path/to/maka-cu node scripts/computer-use.mjs prepare
//   MAKA_CU_SOURCE_BRANCH=maka/base node scripts/computer-use.mjs prepare
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMakaCuSourceBranch } from './prepare-provenance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const destination = join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'maka-cu');

/** Universal and single-architecture Mach-O, both byte orders. */
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function fail(message) {
  process.stderr.write(`computer-use prepare: ${message}\n`);
  process.exit(1);
}

function sourcePath() {
  const explicit = process.env.MAKA_CU_SOURCE;
  if (explicit) return resolve(explicit);
  // A sibling checkout is the layout this repo is developed in; naming it here
  // beats every contributor discovering the variable.
  return resolve(repoRoot, '..', 'maka-cu');
}

function assertMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) fail(`${path} is too short to be an executable.`);
    if (!MACH_O_MAGICS.has(head.readUInt32BE(0)) && !MACH_O_MAGICS.has(head.readUInt32LE(0))) {
      fail(`${path} is not a Mach-O executable.`);
    }
  } finally {
    closeSync(fd);
  }
}

function git(source, args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
}

function sourceBranch(source) {
  const currentBranch = git(source, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteBranches = git(source, [
    'for-each-ref',
    '--points-at',
    'HEAD',
    '--format=%(refname:short)',
    'refs/remotes',
  ]).split('\n');
  try {
    return resolveMakaCuSourceBranch({
      currentBranch,
      remoteBranches,
      explicitBranch: process.env.MAKA_CU_SOURCE_BRANCH,
    });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}. ` +
        'Set MAKA_CU_SOURCE_BRANCH to the source branch this commit belongs to.',
    );
  }
}

const source = sourcePath();
if (!existsSync(join(source, 'Package.swift'))) {
  fail(`no Swift package at ${source}. Set MAKA_CU_SOURCE to the maka-cu checkout.`);
}

// A dirty tree would pin bytes to a commit that does not describe them.
const status = git(source, ['status', '--porcelain']);
if (status && process.env.MAKA_CU_ALLOW_DIRTY !== '1') {
  fail(
    `${source} has uncommitted changes, so the recorded commit would not describe the ` +
      'binary. Commit them, or set MAKA_CU_ALLOW_DIRTY=1 for a throwaway build.',
  );
}

process.stderr.write(`computer-use prepare: building ${source}\n`);
execFileSync('swift', ['build', '-c', 'release', '--package-path', source], { stdio: 'inherit' });

const built = execFileSync(
  'swift',
  ['build', '-c', 'release', '--package-path', source, '--show-bin-path'],
  { encoding: 'utf8' },
).trim();
const binary = join(built, 'OpenComputerUse');
if (!existsSync(binary)) fail(`swift build produced no ${binary}.`);
assertMachO(binary);

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(binary, destination);
chmodSync(destination, 0o755);

// Signing rewrites the file, so the digest is taken after it, from the copy the
// host will actually spawn — hashing the build output first pins bytes nobody
// runs.
//
// Signing with a stable identity is not only about distribution. TCC keys an
// ad-hoc binary by its code directory hash, so every rebuild is a new program
// to macOS and Accessibility has to be granted again; a signed one is
// identified by its designated requirement, which survives a rebuild. Any
// identity does that, including a self-signed one:
//
//   MAKA_CU_SIGN_IDENTITY="Codex++ Local Signing" node scripts/computer-use.mjs prepare
//
// `security find-identity -v -p codesigning` lists what this machine has.
const identity = process.env.MAKA_CU_SIGN_IDENTITY;
if (identity) {
  process.stderr.write(`computer-use prepare: signing with ${identity}\n`);
  execFileSync(
    'codesign',
    ['--force', '--options', 'runtime', '--timestamp=none', '--sign', identity, destination],
    { stdio: 'inherit' },
  );
}

const binarySha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');

/**
 * What the binary is actually signed with, read rather than asserted.
 *
 * `swift build` linker-signs ad-hoc, which runs fine locally — a file built on
 * this machine carries no quarantine flag, so Gatekeeper never looks at it, and
 * TCC attributes the executor to whoever spawned it. It is distribution that
 * needs more: notarization requires every executable in the bundle to be
 * Developer ID signed with the hardened runtime, and one ad-hoc helper fails the
 * whole app.
 *
 * So this reports what it found. A developer who does hold a certificate signs
 * the binary before running this, and the manifest records that — rather than
 * making them hand-edit the field this script would otherwise overwrite.
 */
function signatureOf(path) {
  // codesign writes its whole report to stderr and exits 0 for a signed file,
  // so reading stdout, or only reading stderr on failure, reports every signed
  // binary as unsigned. It did: an ad-hoc binary came back as `none`.
  const probe = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' });
  const text = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!text.trim()) return { signature: 'none', hardenedRuntime: false };
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const authority = /^Authority=(.+)$/m.exec(text)?.[1]?.trim();
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? '';
  const hardenedRuntime = flags.includes('runtime');
  if (authority?.startsWith('Developer ID Application')) {
    return {
      signature: 'developer-id',
      ...(team && team !== 'not set' ? { teamIdentifier: team } : {}),
      hardenedRuntime,
      authority,
    };
  }
  if (flags.includes('adhoc')) return { signature: 'adhoc', hardenedRuntime };
  if (authority) return { signature: 'other', authority, hardenedRuntime };
  return { signature: 'none', hardenedRuntime: false };
}

/** Stapled means the notarization ticket travels with the file, offline. */
function isStapled(path) {
  try {
    execFileSync('xcrun', ['stapler', 'validate', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const signing = signatureOf(destination);
const stapled = isStapled(destination);
// Every condition, or none of it. Distribution is the one place a partial
// answer is worse than a refusal: an ad-hoc helper inside a notarized app is
// not a smaller problem than an unsigned one, it fails the same way.
const distributionReady =
  signing.signature === 'developer-id' && signing.hardenedRuntime === true && stapled;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.makaCu = {
  repo: 'maka-agent/maka-cu',
  branch: sourceBranch(source),
  commit: git(source, ['rev-parse', 'HEAD']),
  expectedProtocolVersion: 'maka.cu/2',
  binaryName: 'maka-cu',
  binarySizeBytes: statSync(destination).size,
  binarySha256,
  buildProvenance: 'local-source-build',
  ...signing,
  notarization: stapled ? 'stapled' : 'missing',
  distributionReady,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stderr.write(
  `computer-use prepare: ${destination}\n` +
    `computer-use prepare: sha256 ${binarySha256}\n` +
    `computer-use prepare: commit ${manifest.makaCu.commit} on ${manifest.makaCu.branch}\n` +
    `computer-use prepare: signature ${signing.signature}` +
    `${signing.hardenedRuntime ? ' + hardened runtime' : ''}` +
    `, notarization ${manifest.makaCu.notarization}` +
    `, distributionReady ${distributionReady}\n` +
    (distributionReady
      ? ''
      : 'computer-use prepare: development only — a packaged build will refuse this entry.\n') +
    (identity
      ? ''
      : 'computer-use prepare: unsigned, so macOS identifies it by its code directory hash — ' +
        'Accessibility has to be granted again after every rebuild. Set ' +
        'MAKA_CU_SIGN_IDENTITY to a codesigning identity (a self-signed one is enough) ' +
        'to make the grant survive.\n'),
);
