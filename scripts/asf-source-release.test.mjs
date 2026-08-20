import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createSourceCandidate,
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
  test('uses the incubating source distribution name', () => {
    assert.deepEqual(sourceCandidateIdentity('0.1.12'), {
      archiveName: 'apache-maka-0.1.12-incubating-src.tar.gz',
      rootDirectory: 'apache-maka-0.1.12-incubating',
      version: '0.1.12',
    });
  });

  test('rejects versions that already contain the incubation marker', () => {
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
      { fingerprint, primaryFingerprint: fingerprint },
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

  test('creates reproducible candidates from committed files only', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-source-test-'));
    const repositoryRoot = join(temporaryRoot, 'repository');
    const repositoryLink = join(temporaryRoot, 'repository-link');
    const firstOutput = join(temporaryRoot, 'first');
    const secondOutput = join(temporaryRoot, 'second');
    const linkedOutput = join(temporaryRoot, 'linked');
    mkdirSync(repositoryRoot, { recursive: true });
    try {
      writeFileSync(
        join(repositoryRoot, 'package.json'),
        `${JSON.stringify({ name: 'maka', version: '0.1.12' }, null, 2)}\n`,
      );
      writeFileSync(
        join(repositoryRoot, 'DISCLAIMER-WIP'),
        'Apache Maka is undergoing incubation at The Apache Software Foundation.\n',
      );
      writeFileSync(join(repositoryRoot, 'LICENSE'), 'Apache License, Version 2.0\n');
      writeFileSync(join(repositoryRoot, 'NOTICE'), 'Apache Maka\n');
      writeFileSync(
        join(repositoryRoot, 'package-lock.json'),
        `${JSON.stringify({ lockfileVersion: 3, name: 'maka', packages: { '': { name: 'maka', version: '0.1.12' } }, version: '0.1.12' }, null, 2)}\n`,
      );
      writeFileSync(join(repositoryRoot, '.gitignore'), 'untracked.txt\n');
      writeFileSync(
        join(repositoryRoot, '.gitattributes'),
        '/.claude export-ignore\n/.maka-shots export-ignore\n/maka-proposal-zh-review.txt export-ignore\n',
      );
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
      const second = await createSourceCandidate({
        outputDirectory: secondOutput,
        repositoryRoot,
        version: '0.1.12',
      });
      assert.deepEqual(readFileSync(first.archivePath), readFileSync(second.archivePath));
      assert.deepEqual(readFileSync(first.checksumPath), readFileSync(second.checksumPath));
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: first.archivePath }));

      const entries = execFileSync('tar', ['-tzf', basename(first.archivePath)], {
        cwd: dirname(first.archivePath),
        encoding: 'utf8',
      });
      assert.doesNotMatch(entries, /untracked\.txt/);
      assert.doesNotMatch(entries, /\.claude|\.maka-shots|maka-proposal-zh-review/);

      const gpgHome = join(temporaryRoot, 'gnupg');
      const keysPath = join(temporaryRoot, 'KEYS');
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
          'ASF Release Test <release-test@example.invalid>',
          'rsa2048',
          'sign',
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
      await assert.rejects(
        () =>
          signSourceCandidate({
            archivePath: first.archivePath,
            gpgHome,
            keyFingerprint: fingerprint.slice(-16),
            repositoryRoot,
            revision: first.commit,
          }),
        /complete hexadecimal PGP key fingerprint/,
      );
      await assert.doesNotReject(() =>
        signSourceCandidate({
          archivePath: first.archivePath,
          gpgHome,
          keyFingerprint: fingerprint,
          repositoryRoot,
          revision: first.commit,
        }),
      );
      execFileSync(
        'gpg',
        ['--batch', '--homedir', gpgHome, '--armor', '--output', keysPath, '--export', fingerprint],
        { stdio: 'ignore' },
      );
      await assert.doesNotReject(() =>
        verifySourceCandidate({ archivePath: first.archivePath, keysPath }),
      );

      symlinkSync(repositoryRoot, repositoryLink, 'dir');
      const linkedScript = join(repositoryLink, 'scripts/asf-source-release.mjs');
      mkdirSync(join(repositoryRoot, 'scripts'));
      writeFileSync(
        join(repositoryRoot, 'scripts/asf-source-release.mjs'),
        readFileSync(join(import.meta.dirname, 'asf-source-release.mjs')),
      );
      git(repositoryRoot, ['add', 'scripts/asf-source-release.mjs']);
      git(repositoryRoot, [
        '-c',
        'user.name=ASF Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        'commit',
        '-m',
        'add release script',
      ]);
      await assert.rejects(
        () =>
          reproduceSourceCandidate({
            archivePath: first.archivePath,
            repositoryRoot,
            revision: 'HEAD',
          }),
        /Candidate bytes do not match/,
      );
      execFileSync(
        process.execPath,
        [
          linkedScript,
          'create',
          '--version',
          '0.1.12',
          '--revision',
          'HEAD',
          '--output',
          linkedOutput,
        ],
        { stdio: 'ignore' },
      );
      await assert.doesNotReject(() =>
        verifySourceCandidate({
          archivePath: join(linkedOutput, 'apache-maka-0.1.12-incubating-src.tar.gz'),
        }),
      );

      const mismatchedLock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json')));
      mismatchedLock.version = '9.9.9';
      writeFileSync(
        join(repositoryRoot, 'package-lock.json'),
        `${JSON.stringify(mismatchedLock, null, 2)}\n`,
      );
      git(repositoryRoot, ['add', 'package-lock.json']);
      git(repositoryRoot, [
        '-c',
        'user.name=ASF Release Test',
        '-c',
        'user.email=release-test@example.invalid',
        'commit',
        '-m',
        'mismatch lock version',
      ]);
      await assert.rejects(
        () =>
          createSourceCandidate({
            outputDirectory: join(temporaryRoot, 'mismatched'),
            repositoryRoot,
            version: '0.1.12',
          }),
        /package-lock\.json.*9\.9\.9/,
      );
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});

function git(repositoryRoot, arguments_) {
  execFileSync('git', arguments_, { cwd: repositoryRoot, stdio: 'ignore' });
}
