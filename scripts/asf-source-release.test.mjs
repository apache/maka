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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createSourceCandidate,
  controlledProcessEnvironment,
  parseSha512File,
  reproduceSourceCandidate,
  signSourceCandidate,
  sourceCandidateIdentity,
  validateArchiveEntries,
  validateGpgVerificationStatus,
  validatePackageVersions,
  verifySourceCandidate,
} from './asf-source-release.mjs';

describe('ASF source release identity', () => {
  test('uses the incubating source distribution name for plain versions only', () => {
    assert.deepEqual(sourceCandidateIdentity('0.1.12'), {
      archiveName: 'apache-maka-0.1.12-incubating-src.tar.gz',
      rootDirectory: 'apache-maka-0.1.12-incubating',
      version: '0.1.12',
    });
    assert.throws(() => sourceCandidateIdentity('0.1.12-incubating'), /Invalid release version/);
  });
});

describe('ASF source release verification', () => {
  test('validates checksum identity and archive boundaries', () => {
    const name = 'apache-maka-0.1.12-incubating-src.tar.gz';
    assert.equal(parseSha512File(`${'a'.repeat(128)}  ${name}\n`, name), 'a'.repeat(128));
    assert.throws(() => parseSha512File(`${'a'.repeat(128)}  another.tar.gz\n`, name), /expected/);

    const root = 'apache-maka-0.1.12-incubating';
    assert.doesNotThrow(() =>
      validateArchiveEntries(
        [
          `${root}/`,
          `${root}/DISCLAIMER-WIP`,
          `${root}/LICENSE`,
          `${root}/NOTICE`,
          `${root}/package-lock.json`,
          `${root}/package.json`,
          `${root}/src/index.ts`,
        ],
        root,
      ),
    );
    assert.throws(
      () =>
        validateArchiveEntries(
          [
            `${root}/DISCLAIMER-WIP`,
            `${root}/LICENSE`,
            `${root}/NOTICE`,
            `${root}/package-lock.json`,
            `${root}/package.json`,
            `${root}/.maka-shots/review.png`,
            `${root}/node_modules/dependency/index.js`,
          ],
          root,
        ),
      /Forbidden archive entry/,
    );
  });

  test('requires one current valid GPG signature status', () => {
    const fingerprint = 'A'.repeat(40);
    assert.deepEqual(
      validateGpgVerificationStatus(
        `[GNUPG:] GOODSIG ABCDEF0123456789 Release Test\n[GNUPG:] VALIDSIG ${fingerprint} 2026-08-20 1787193600 0 4 0 1 10 00 ${fingerprint}\n`,
      ),
      { fingerprint, hashAlgorithm: 10 },
    );
    for (const status of ['EXPKEYSIG', 'EXPSIG', 'KEYEXPIRED', 'KEYREVOKED', 'REVKEYSIG']) {
      assert.throws(
        () =>
          validateGpgVerificationStatus(
            `[GNUPG:] ${status} ABCDEF0123456789 Release Test\n[GNUPG:] GOODSIG ABCDEF0123456789 Release Test\n[GNUPG:] VALIDSIG ${fingerprint} 2026-08-20 1787193600 0 4 0 1 10 00 ${fingerprint}\n`,
          ),
        new RegExp(status),
      );
    }
  });

  test('requires package and lockfile versions to share one identity', () => {
    const packageJson = { version: '0.1.12' };
    const packageLock = { packages: { '': { version: '0.1.12' } }, version: '0.1.12' };
    assert.doesNotThrow(() =>
      validatePackageVersions({ packageJson, packageLock, source: 'fixture', version: '0.1.12' }),
    );
    assert.throws(
      () =>
        validatePackageVersions({
          packageJson,
          packageLock: { ...packageLock, version: '9.9.9' },
          source: 'fixture',
          version: '0.1.12',
        }),
      /package-lock\.json.*9\.9\.9/,
    );
  });

  test('filters controlled environment names case-insensitively', async () => {
    await withEnvironmentVariables(
      { gIt_Prefix_Probe: 'prefix', mAkA_Exact_Probe: 'exact' },
      () => {
        const environment = controlledProcessEnvironment({
          excludedNames: ['MAKA_EXACT_PROBE'],
          excludedPrefixes: ['GIT_'],
          overrides: { GIT_CONFIG_NOSYSTEM: '1' },
        });
        const names = Object.keys(environment).map((name) => name.toUpperCase());
        assert.equal(names.includes('MAKA_EXACT_PROBE'), false);
        assert.equal(names.includes('GIT_PREFIX_PROBE'), false);
        assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
      },
    );
  });

  test('requires a signature before reading unauthenticated candidate metadata', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-auth-order-test-'));
    const identity = sourceCandidateIdentity('0.1.12');
    const archivePath = join(temporaryRoot, identity.archiveName);
    try {
      writeFileSync(archivePath, 'not a tar archive\n');
      const keysPath = join(temporaryRoot, 'KEYS');
      writeFileSync(keysPath, '');

      await assert.rejects(
        () => verifySourceCandidate({ archivePath, keysPath }),
        /Detached signature does not exist/,
      );
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  test('creates reproducible candidates from committed files only', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-source-test-'));
    const repositoryRoot = join(temporaryRoot, 'repository');
    const firstOutput = join(temporaryRoot, 'first');
    const hostileOutput = join(temporaryRoot, 'hostile');
    mkdirSync(repositoryRoot, { recursive: true });
    try {
      writeReleaseContents(repositoryRoot, { includeAttributes: true });
      writeFileSync(join(repositoryRoot, '.gitignore'), 'untracked.txt\n');
      writeFileSync(join(repositoryRoot, 'README.md'), 'release fixture\n'.repeat(4096));
      writeFileSync(join(repositoryRoot, 'untracked.txt'), 'must not be released\n');
      mkdirSync(join(repositoryRoot, '.claude'));
      mkdirSync(join(repositoryRoot, '.maka-shots'));
      writeFileSync(join(repositoryRoot, '.claude/launch.json'), '{}\n');
      writeFileSync(join(repositoryRoot, '.maka-shots/review.png'), 'review evidence\n');
      writeFileSync(join(repositoryRoot, 'maka-proposal-zh-review.txt'), 'working notes\n');

      git(repositoryRoot, ['init']);
      git(repositoryRoot, [
        'add',
        'package.json',
        'package-lock.json',
        'DISCLAIMER-WIP',
        'LICENSE',
        'NOTICE',
        '.gitignore',
        '.gitattributes',
        'README.md',
        '.claude/launch.json',
        '.maka-shots/review.png',
        'maka-proposal-zh-review.txt',
      ]);
      git(repositoryRoot, [
        '-c',
        'user.name=ASF Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        'commit',
        '-m',
        'test fixture',
      ]);

      const first = await createSourceCandidate({
        outputDirectory: firstOutput,
        repositoryRoot,
        version: '0.1.12',
      });
      await assert.rejects(
        () =>
          createSourceCandidate({
            outputDirectory: firstOutput,
            repositoryRoot,
            version: '0.1.12',
          }),
        /Refusing to overwrite existing release output/,
      );
      git(repositoryRoot, ['config', 'tar.umask', '0077']);
      writeFileSync(join(repositoryRoot, '.git/info/attributes'), 'README.md export-ignore\n');

      const ambientTemplate = join(temporaryRoot, 'ambient-template');
      mkdirSync(join(ambientTemplate, 'info'), { recursive: true });
      writeFileSync(join(ambientTemplate, 'info/attributes'), 'README.md export-ignore\n');

      const ambientRepository = join(temporaryRoot, 'ambient-repository');
      git(temporaryRoot, ['clone', '--quiet', repositoryRoot, ambientRepository]);
      writeFileSync(join(ambientRepository, 'README.md'), 'ambient repository\n');
      git(ambientRepository, ['add', 'README.md']);
      git(ambientRepository, [
        '-c',
        'user.name=ASF Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        'commit',
        '-m',
        'change ambient repository',
      ]);
      const hostile = await withEnvironmentVariables(
        {
          GIT_DIR: join(ambientRepository, '.git'),
          GIT_TEMPLATE_DIR: ambientTemplate,
          GZIP: '-l',
        },
        () =>
          createSourceCandidate({
            outputDirectory: hostileOutput,
            repositoryRoot,
            version: '0.1.12',
          }),
      );
      assert.deepEqual(readFileSync(first.archivePath), readFileSync(hostile.archivePath));
      assert.equal(hostile.commit, first.commit);
      assert.deepEqual(
        readFileSync(`${first.archivePath}.sha512`),
        readFileSync(`${hostile.archivePath}.sha512`),
      );
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: first.archivePath }));

      const entries = execFileSync('tar', ['-tzf', basename(first.archivePath)], {
        cwd: dirname(first.archivePath),
        encoding: 'utf8',
      });
      assert.doesNotMatch(entries, /untracked\.txt/);
      assert.doesNotMatch(entries, /\.claude|\.maka-shots|maka-proposal-zh-review/);
      assert.match(entries, /README\.md/);

      const originalCompressedBytes = readFileSync(first.archivePath);
      rewriteArchiveCompression(first.archivePath, 1);
      assert.notDeepEqual(readFileSync(first.archivePath), originalCompressedBytes);
      await assert.doesNotReject(() =>
        reproduceSourceCandidate({
          archivePath: first.archivePath,
          repositoryRoot,
          revision: first.commit,
        }),
      );
      writeFileSync(join(repositoryRoot, 'README.md'), 'different committed payload\n');
      git(repositoryRoot, ['add', 'README.md']);
      commitFixture(repositoryRoot, 'change candidate payload');
      await assert.rejects(
        () =>
          reproduceSourceCandidate({
            archivePath: first.archivePath,
            repositoryRoot,
            revision: 'HEAD',
          }),
        /Candidate source payload does not match/,
      );

      const gpgHome = join(temporaryRoot, 'gnupg');
      const keysPath = join(temporaryRoot, 'KEYS');
      const fingerprint = generateSigningKey({
        algorithm: 'rsa2048',
        gpgHome,
        identity: 'ASF Release Test <release-test@example.invalid>',
        signingSubkeyAlgorithm: 'rsa2048',
        usage: 'cert',
      });
      writeFileSync(join(gpgHome, 'gpg.conf'), 'digest-algo SHA1\n');
      await assert.doesNotReject(() =>
        signSourceCandidate({
          archivePath: first.archivePath,
          gpgHome,
          keyFingerprint: fingerprint,
          repositoryRoot,
          revision: first.commit,
        }),
      );
      exportPublicKey({ fingerprint, gpgHome, keysPath });
      await assert.doesNotReject(() =>
        verifySourceCandidate({ archivePath: first.archivePath, keysPath }),
      );

      rmSync(`${first.archivePath}.asc`);
      execFileSync(
        'gpg',
        [
          '--batch',
          '--homedir',
          gpgHome,
          '--digest-algo',
          'SHA512',
          '--detach-sign',
          '--output',
          `${first.archivePath}.asc`,
          first.archivePath,
        ],
        { stdio: 'ignore' },
      );
      const checksum = readFileSync(`${first.archivePath}.sha512`);
      writeFileSync(`${first.archivePath}.sha512`, 'not a checksum\n');
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: first.archivePath, keysPath }),
        /ASCII-armored/,
      );
      writeFileSync(`${first.archivePath}.sha512`, checksum);

      rmSync(`${first.archivePath}.asc`);
      execFileSync(
        'gpg',
        [
          '--batch',
          '--homedir',
          gpgHome,
          '--armor',
          '--digest-algo',
          'SHA1',
          '--detach-sign',
          '--output',
          `${first.archivePath}.asc`,
          first.archivePath,
        ],
        { stdio: 'ignore' },
      );
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: first.archivePath, keysPath }),
        /must use SHA-256, SHA-384, or SHA-512/,
      );

      rmSync(`${first.archivePath}.asc`);
      // Keep the homedir short enough for GPG agent socket paths on macOS.
      const ed25519Home = join(temporaryRoot, 'ed');
      const ed25519Fingerprint = generateSigningKey({
        algorithm: 'ed25519',
        gpgHome: ed25519Home,
        identity: 'ASF Ed25519 Release Test <release-test@example.invalid>',
      });
      await assert.rejects(
        () =>
          signSourceCandidate({
            archivePath: first.archivePath,
            gpgHome: ed25519Home,
            keyFingerprint: ed25519Fingerprint,
            repositoryRoot,
            revision: first.commit,
          }),
        /must be RSA with at least 2048 bits/,
      );
      assert.equal(existsSync(`${first.archivePath}.asc`), false);

      const rsa1024Home = join(temporaryRoot, 'r');
      const rsa1024Fingerprint = generateSigningKey({
        algorithm: 'rsa2048',
        gpgHome: rsa1024Home,
        identity: 'ASF RSA-1024 Subkey Test <release-test@example.invalid>',
        signingSubkeyAlgorithm: 'rsa1024',
        usage: 'cert',
      });
      await assert.rejects(
        () =>
          signSourceCandidate({
            archivePath: first.archivePath,
            gpgHome: rsa1024Home,
            keyFingerprint: rsa1024Fingerprint,
            repositoryRoot,
            revision: first.commit,
          }),
        /must be RSA with at least 2048 bits/,
      );
      assert.equal(existsSync(`${first.archivePath}.asc`), false);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  test('does not let ambient tar options control archive verification', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-tar-options-test-'));
    const identity = sourceCandidateIdentity('0.1.12');
    const sourceRoot = join(temporaryRoot, identity.rootDirectory);
    const archivePath = join(temporaryRoot, identity.archiveName);
    try {
      writeReleaseContents(sourceRoot);
      mkdirSync(join(sourceRoot, '.agents'), { recursive: true });
      writeFileSync(join(sourceRoot, '.agents/secret.txt'), 'must not be released\n');
      execFileSync('tar', ['-czf', archivePath, identity.rootDirectory], {
        cwd: temporaryRoot,
        stdio: 'ignore',
      });
      const digest = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
      writeFileSync(`${archivePath}.sha512`, `${digest}  ${identity.archiveName}\n`);

      for (const [name, value] of Object.entries({
        GZIP: '-l',
        TAR_OPTIONS: `--exclude=${identity.rootDirectory}/.agents`,
        TAR_READER_OPTIONS: 'tar:hdrcharset=BOGUS',
      })) {
        await withEnvironmentVariables({ [name]: value }, () =>
          assert.rejects(() => verifySourceCandidate({ archivePath }), /Forbidden archive entry/),
        );
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});

function git(repositoryRoot, arguments_) {
  execFileSync('git', arguments_, { cwd: repositoryRoot, stdio: 'ignore' });
}

function writeReleaseContents(root, { includeAttributes = false } = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'maka', version: '0.1.12' }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, name: 'maka', packages: { '': { name: 'maka', version: '0.1.12' } }, version: '0.1.12' }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'DISCLAIMER-WIP'),
    'Apache Maka is undergoing incubation at The Apache Software Foundation.\n',
  );
  writeFileSync(join(root, 'LICENSE'), 'Apache License, Version 2.0\n');
  writeFileSync(join(root, 'NOTICE'), 'Apache Maka\n');
  if (includeAttributes) {
    copyFileSync(join(import.meta.dirname, '../.gitattributes'), join(root, '.gitattributes'));
  }
}

function commitFixture(repositoryRoot, message) {
  git(repositoryRoot, [
    '-c',
    'user.name=ASF Release Test',
    '-c',
    'user.email=release-test@example.invalid',
    'commit',
    '-m',
    message,
  ]);
}

async function withEnvironmentVariables(values, callback) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function rewriteArchiveCompression(archivePath, level) {
  const tarPath = archivePath.slice(0, -3);
  execFileSync('gzip', ['-d', archivePath], { stdio: 'ignore' });
  execFileSync('gzip', ['-n', `-${level}`, tarPath], { stdio: 'ignore' });
  const digest = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha512`, `${digest}  ${basename(archivePath)}\n`);
}

function generateSigningKey({
  algorithm,
  gpgHome,
  identity,
  signingSubkeyAlgorithm,
  usage = 'sign',
}) {
  mkdirSync(gpgHome, { mode: 0o700 });
  chmodSync(gpgHome, 0o700);
  execFileSync(
    'gpg',
    [
      '--batch',
      '--homedir',
      gpgHome,
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      identity,
      algorithm,
      usage,
      '1d',
    ],
    { stdio: 'ignore' },
  );
  const fingerprint = execFileSync(
    'gpg',
    ['--batch', '--homedir', gpgHome, '--with-colons', '--fingerprint', '--list-secret-keys'],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .find((line) => line.startsWith('fpr:'))
    ?.split(':')[9];
  assert.match(fingerprint, /^[0-9A-F]{40}$/);
  if (signingSubkeyAlgorithm) {
    execFileSync(
      'gpg',
      [
        '--batch',
        '--homedir',
        gpgHome,
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-add-key',
        fingerprint,
        signingSubkeyAlgorithm,
        'sign',
        '1d',
      ],
      { stdio: 'ignore' },
    );
  }
  return fingerprint;
}

function exportPublicKey({ fingerprint, gpgHome, keysPath }) {
  execFileSync(
    'gpg',
    ['--batch', '--homedir', gpgHome, '--armor', '--output', keysPath, '--export', fingerprint],
    { stdio: 'ignore' },
  );
}
