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
    assert.throws(
      () =>
        validateArchiveEntries(
          [
            `${root}/DISCLAIMER-WIP`,
            `${root}/LICENSE`,
            `${root}/NOTICE`,
            `${root}/package-lock.json`,
            `${root}/package.json`,
            `${root}/fixtures/evil.bin`,
            `${root}/fixtures/EVIL.BIN`,
          ],
          root,
        ),
      /Cross-platform archive entry collision/,
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

  test('rejects Category X dependencies from a nested package lockfile', async () => {
    const fixture = createFixtureCandidate({
      'tools/runtime/package.json': `${JSON.stringify({ name: 'runtime', private: true, license: 'Apache-2.0' })}\n`,
      'tools/runtime/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        name: 'runtime',
        packages: {
          '': { name: 'runtime', license: 'Apache-2.0' },
          'node_modules/category-x-runtime': {
            version: '1.0.0',
            license: 'LGPL-3.0-or-later',
          },
        },
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Category X.*category-x-runtime.*LGPL-3\.0-or-later/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('accepts a classified dependency from a nested package lockfile', async () => {
    const fixture = createFixtureCandidate({
      'tools/source/package.json': `${JSON.stringify({
        dependencies: { 'source-helper': '1.0.0' },
        name: 'source',
        private: true,
      })}\n`,
      'tools/source/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        name: 'source',
        packages: {
          '': { name: 'source', license: 'Apache-2.0' },
          'node_modules/source-helper': { version: '1.0.0', license: 'MIT' },
        },
      })}\n`,
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects an unclassified dependency from a nested package lockfile', async () => {
    const fixture = createFixtureCandidate({
      'tools/unknown/package.json': `${JSON.stringify({ name: 'unknown', private: true, license: 'Apache-2.0' })}\n`,
      'tools/unknown/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        name: 'unknown',
        packages: {
          '': { name: 'unknown', license: 'Apache-2.0' },
          'node_modules/unknown-runtime': { version: '1.0.0' },
        },
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify unknown-runtime@1\.0\.0.*tools\/unknown\/package-lock\.json/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('accepts an unlicensed private manifest without dependencies', async () => {
    const fixture = createFixtureCandidate({
      'tools/profile/package.json': `${JSON.stringify({ name: 'profile', private: true })}\n`,
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unlicensed private manifests whose dependencies lack lock provenance', async () => {
    const dependencyDeclarations = {
      bundleDependencies: ['runtime-helper'],
      bundledDependencies: ['runtime-helper'],
      dependencies: { 'runtime-helper': '1.0.0' },
      devDependencies: { 'runtime-helper': '1.0.0' },
      optionalDependencies: { 'runtime-helper': '1.0.0' },
      peerDependencies: { 'runtime-helper': '1.0.0' },
    };
    for (const [field, declaration] of Object.entries(dependencyDeclarations)) {
      const fixture = createFixtureCandidate({
        [`tools/${field}/package.json`]: `${JSON.stringify({
          [field]: declaration,
          name: field,
          private: true,
        })}\n`,
      });
      try {
        await assert.rejects(
          () => verifySourceCandidate({ archivePath: fixture.archivePath }),
          new RegExp(
            `Cannot safely classify.*${field}.*without (?:matching )?lock provenance`,
            'u',
          ),
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('does not accept arbitrary notice files as dependency license authority', async () => {
    const fixture = createFixtureCandidate({
      'tools/runtime/THIRD_PARTY_NOTICES.txt':
        'Package: unknown-runtime@1.0.0\nSelected license: MIT\n',
      'tools/runtime/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'runtime' },
          'node_modules/unknown-runtime': { version: '1.0.0' },
        },
      })}\n`,
      'tools/runtime/package.json': `${JSON.stringify({
        dependencies: { 'unknown-runtime': '1.0.0' },
        license: 'Apache-2.0',
        name: 'runtime',
        private: true,
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify unknown-runtime@1\.0\.0/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('uses the generated npm notice as the dependency license authority', async () => {
    const fixture = createFixtureCandidate({
      'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt':
        'Package: source-helper@1.0.0\nSelected license: MIT\n',
      'tools/source/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'source' },
          'node_modules/source-helper': { version: '1.0.0' },
        },
      })}\n`,
      'tools/source/package.json': `${JSON.stringify({
        dependencies: { 'source-helper': '1.0.0' },
        name: 'source',
        private: true,
      })}\n`,
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('does not let lock metadata override a Category X generated notice', async () => {
    const fixture = createFixtureCandidate({
      'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt':
        'Package: disguised-runtime@1.0.0\nSelected license: GPL-3.0-only\n',
      'tools/runtime/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'runtime' },
          'node_modules/disguised-runtime': { license: 'MIT', version: '1.0.0' },
        },
      })}\n`,
      'tools/runtime/package.json': `${JSON.stringify({
        dependencies: { 'disguised-runtime': '1.0.0' },
        license: 'Apache-2.0',
        name: 'runtime',
        private: true,
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Category X.*disguised-runtime.*GPL-3\.0-only/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects lock links without a candidate-owned workspace target', async () => {
    const fixture = createFixtureCandidate({
      'tools/runtime/package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'runtime' },
          'node_modules/evil-runtime': { link: true, resolved: '../../evil-runtime' },
        },
      })}\n`,
      'tools/runtime/package.json': `${JSON.stringify({ license: 'Apache-2.0', name: 'runtime' })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify workspace link.*evil-runtime/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects Category X metadata on workspace package lock entries', async () => {
    const fixture = createFixtureCandidate({
      'packages/evil/package.json': `${JSON.stringify({
        license: 'Apache-2.0',
        name: 'evil',
        version: '1.0.0',
      })}\n`,
      'package-lock.json': `${JSON.stringify({
        lockfileVersion: 3,
        name: 'maka',
        packages: {
          '': { name: 'maka', version: '0.1.12' },
          'packages/evil': { license: 'GPL-3.0-only', name: 'evil', version: '1.0.0' },
        },
        version: '0.1.12',
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Category X.*packages\/evil.*GPL-3\.0-only/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('binds licensed manifest dependencies to a package lock closure', async () => {
    const fixture = createFixtureCandidate({
      'tools/runtime/package.json': `${JSON.stringify({
        dependencies: { 'unlocked-runtime': '1.0.0' },
        license: 'Apache-2.0',
        name: 'runtime',
        private: true,
      })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify.*tools\/runtime\/package\.json.*without (?:matching )?lock provenance/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unsupported npm lockfile versions', async () => {
    const fixture = createFixtureCandidate({
      'tools/runtime/package-lock.json': `${JSON.stringify({
        lockfileVersion: 99,
        packages: { '': { name: 'runtime' } },
      })}\n`,
      'tools/runtime/package.json': `${JSON.stringify({ license: 'Apache-2.0', name: 'runtime' })}\n`,
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Unsupported npm lockfile version 99/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('classifies dependencies from a nested npm shrinkwrap', async () => {
    const fixture = createFixtureCandidate({
      'tools/source/npm-shrinkwrap.json': `${JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'source' },
          'node_modules/source-helper': { license: 'MIT', version: '1.0.0' },
        },
      })}\n`,
      'tools/source/package.json': `${JSON.stringify({
        dependencies: { 'source-helper': '1.0.0' },
        name: 'source',
        private: true,
      })}\n`,
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unsupported nested package manager lockfiles', async () => {
    for (const [name, contents] of [
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['yarn.lock', '# yarn lockfile v1\n'],
    ]) {
      const fixture = createFixtureCandidate({ [`tools/source/${name}`]: contents });
      try {
        await assert.rejects(
          () => verifySourceCandidate({ archivePath: fixture.archivePath }),
          /Cannot safely classify unsupported package lockfile/,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('rejects Category X and unknown nested package manifest licenses', async () => {
    for (const [license, expected] of [
      ['AGPL-3.0-only', /Category X/],
      ['LicenseRef-Unknown', /Cannot safely classify license/],
    ]) {
      const fixture = createFixtureCandidate({
        'tools/source/package.json': `${JSON.stringify({ license, name: 'source' })}\n`,
      });
      try {
        await assert.rejects(
          () => verifySourceCandidate({ archivePath: fixture.archivePath }),
          expected,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('rejects compiled artifacts regardless of their file extension', async () => {
    const formats = new Map([
      ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
      ['Mach-O', Buffer.from([0xfe, 0xed, 0xfa, 0xcf])],
      ['Mach-O fat little-endian', Buffer.from([0xbe, 0xba, 0xfe, 0xca])],
      ['Mach-O fat64 little-endian', Buffer.from([0xbf, 0xba, 0xfe, 0xca])],
      ['PE', Buffer.from('MZ')],
      ['WASM', Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])],
      ['ZIP/JAR', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
      ['thin ar archive', Buffer.from('!<thin>\n')],
    ]);
    for (const [format, bytes] of formats) {
      const fixture = createFixtureCandidate({
        'docs/code-origin-audit.md':
          '### Source archive non-text inventory\n\n- `fixtures/runtime.dat`: a claimed fixture.\n',
        'fixtures/runtime.dat': bytes,
      });
      try {
        await assert.rejects(
          () => verifySourceCandidate({ archivePath: fixture.archivePath }),
          new RegExp(`Compiled artifact.*fixtures/runtime\\.dat.*${format.replace('/', '\\/')}`),
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('rejects ZIP payloads hidden behind an allowed source prefix', async () => {
    for (const bytes of [
      Buffer.concat([Buffer.from('source preface\n'), Buffer.from([0x50, 0x4b, 0x03, 0x04])]),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      ]),
    ]) {
      const fixture = createFixtureCandidate({
        'docs/code-origin-audit.md':
          '### Source archive non-text inventory\n\n- `fixtures/runtime.dat`: a claimed fixture.\n',
        'fixtures/runtime.dat': bytes,
      });
      try {
        await assert.rejects(
          () => verifySourceCandidate({ archivePath: fixture.archivePath }),
          /forbidden ZIP\/JAR content/,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('accepts an inventoried source image', async () => {
    const fixture = createFixtureCandidate({
      'docs/code-origin-audit.md':
        '### Source archive non-text inventory\n\n- `fixtures/*.png`: test-generated source images.\n',
      'fixtures/source.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('accepts an inventoried non-text source fixture', async () => {
    const fixture = createFixtureCandidate({
      'docs/code-origin-audit.md':
        '### Source archive non-text inventory\n\n- `fixtures/control.ts`: a raw control-character fixture.\n',
      'fixtures/control.ts': Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x78, 0x00]),
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unknown non-text release inputs', async () => {
    const fixture = createFixtureCandidate({ 'fixtures/unknown.bin': Buffer.from([0x01, 0x02]) });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify non-text release input.*fixtures\/unknown\.bin/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unknown binary paths even when their bytes are valid UTF-8', async () => {
    const fixture = createFixtureCandidate({
      'fixtures/unknown.bin': Buffer.from('printable but still an unknown binary input'),
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify non-text release input.*fixtures\/unknown\.bin/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps provenance inventory entries inside their Markdown section', async () => {
    const fixture = createFixtureCandidate({
      'docs/code-origin-audit.md':
        '### Source archive non-text inventory\n\n## Another section\n\n- `fixtures/unknown.bin`: outside the inventory.\n',
      'fixtures/unknown.bin': Buffer.from([0x01, 0x02]),
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Cannot safely classify non-text release input.*fixtures\/unknown\.bin/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects provenance patterns without a fixed path prefix', async () => {
    const fixture = createFixtureCandidate({
      'docs/code-origin-audit.md':
        '### Source archive non-text inventory\n\n- `**`: overbroad inventory.\n',
      'fixtures/unknown.bin': Buffer.from([0x01, 0x02]),
    });
    try {
      await assert.rejects(
        () => verifySourceCandidate({ archivePath: fixture.archivePath }),
        /Unsafe source archive inventory pattern/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('allows a double-star inventory to match zero nested directories', async () => {
    const fixture = createFixtureCandidate({
      'docs/code-origin-audit.md':
        '### Source archive non-text inventory\n\n- `docs/images/**/*.png`: reviewed screenshots.\n',
      'docs/images/root.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    try {
      await assert.doesNotReject(() => verifySourceCandidate({ archivePath: fixture.archivePath }));
    } finally {
      fixture.cleanup();
    }
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

  test('documents the checkout-only DeepSeek Harness toolchain build in the candidate', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-dsh-contract-test-'));
    const repositoryRoot = join(temporaryRoot, 'repository');
    const outputDirectory = join(temporaryRoot, 'release');
    const identity = sourceCandidateIdentity('0.1.12');
    try {
      writeReleaseContents(repositoryRoot, { includeAttributes: true });
      mkdirSync(join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain'), {
        recursive: true,
      });
      mkdirSync(join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-profile'), {
        recursive: true,
      });
      mkdirSync(join(repositoryRoot, 'scripts'), { recursive: true });
      copyFileSync(
        join(import.meta.dirname, '../packages/eval/README.md'),
        join(repositoryRoot, 'packages/eval/README.md'),
      );
      writeFileSync(
        join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain/package.json'),
        '{}\n',
      );
      writeFileSync(
        join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain/package-lock.json'),
        '{}\n',
      );
      writeFileSync(
        join(repositoryRoot, 'scripts/prepare-deepseek-harness-toolchain.mjs'),
        'export {};\n',
      );
      for (const name of ['package.json', 'cordis.patch.yml']) {
        copyFileSync(
          join(import.meta.dirname, `../packages/eval/harbor/deepseek-harness-profile/${name}`),
          join(repositoryRoot, `packages/eval/harbor/deepseek-harness-profile/${name}`),
        );
      }

      git(repositoryRoot, ['init']);
      git(repositoryRoot, ['add', '.']);
      commitFixture(repositoryRoot, 'test DSH source archive contract');

      const candidate = await createSourceCandidate({
        outputDirectory,
        repositoryRoot,
        version: '0.1.12',
      });
      const entries = execFileSync('tar', ['-tzf', candidate.archivePath], { encoding: 'utf8' });
      const archivedReadme = execFileSync(
        'tar',
        ['-xOzf', candidate.archivePath, `${identity.rootDirectory}/packages/eval/README.md`],
        { encoding: 'utf8' },
      );

      assert.doesNotMatch(entries, /deepseek-harness-toolchain\/package(?:-lock)?\.json/);
      assert.match(entries, /scripts\/prepare-deepseek-harness-toolchain\.mjs/);
      for (const name of ['package.json', 'cordis.patch.yml']) {
        const relativePath = `packages/eval/harbor/deepseek-harness-profile/${name}`;
        assert.deepEqual(
          execFileSync('tar', [
            '-xOzf',
            candidate.archivePath,
            `${identity.rootDirectory}/${relativePath}`,
          ]),
          readFileSync(join(repositoryRoot, relativePath)),
        );
      }
      assert.match(archivedReadme, /only from a complete Git checkout/u);
      assert.match(archivedReadme, /intentionally excluded from ASF source archives/u);
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
      mkdirSync(join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain'), {
        recursive: true,
      });
      mkdirSync(join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-profile'), {
        recursive: true,
      });
      writeFileSync(
        join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain/package-lock.json'),
        '{}\n',
      );
      writeFileSync(
        join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-toolchain/package.json'),
        '{}\n',
      );
      writeFileSync(
        join(
          repositoryRoot,
          'packages/eval/harbor/deepseek-harness-toolchain/patch-subprocess-local.mjs',
        ),
        'export {};\n',
      );
      writeFileSync(
        join(repositoryRoot, 'packages/eval/harbor/deepseek-harness-profile/cordis.yml'),
        'profile: maka-eval\n',
      );

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
        'packages/eval/harbor/deepseek-harness-toolchain/package-lock.json',
        'packages/eval/harbor/deepseek-harness-toolchain/package.json',
        'packages/eval/harbor/deepseek-harness-toolchain/patch-subprocess-local.mjs',
        'packages/eval/harbor/deepseek-harness-profile/cordis.yml',
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
      assert.doesNotMatch(entries, /deepseek-harness-toolchain\/package(?:-lock)?\.json/);
      assert.match(entries, /deepseek-harness-toolchain\/patch-subprocess-local\.mjs/);
      assert.match(entries, /deepseek-harness-profile\/cordis\.yml/);
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
    `${JSON.stringify({ license: 'Apache-2.0', name: 'maka', private: true, version: '0.1.12' }, null, 2)}\n`,
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

function createFixtureCandidate(files = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-asf-candidate-test-'));
  const identity = sourceCandidateIdentity('0.1.12');
  const sourceRoot = join(temporaryRoot, identity.rootDirectory);
  const archivePath = join(temporaryRoot, identity.archiveName);
  writeReleaseContents(sourceRoot);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(sourceRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  execFileSync('tar', ['-czf', archivePath, identity.rootDirectory], {
    cwd: temporaryRoot,
    stdio: 'ignore',
  });
  const digest = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha512`, `${digest}  ${identity.archiveName}\n`);
  return {
    archivePath,
    cleanup: () => rmSync(temporaryRoot, { force: true, recursive: true }),
  };
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
