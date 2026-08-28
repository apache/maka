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
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  RuntimeHostUpdatePackageError,
  assertRuntimeHostArchiveExpansionBudget,
  withRuntimeHostRegistryUpdateArtifact,
  withRuntimeHostRegistryUpdatePackage,
  withVerifiedRuntimeHostUpdateArchive,
} from '../runtime-host-update-package.js';

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write(type, 156, 'latin1');
  header.write('        ', 148, 'latin1');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

function tgz(entries: ReadonlyArray<{ name: string; body?: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    blocks.push(tarHeader(entry.name, body.length, entry.type));
    blocks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const ARCHIVE = tgz([{ name: 'package/package.json', body: Buffer.from('{"name":"maka-agent"}') }]);
const INTEGRITY = `sha512-${createHash('sha512').update(ARCHIVE).digest('base64')}`;

describe('managed Runtime Host update package acquisition', () => {
  it('keeps the verified archive available for an installation-owner finalizer', async () => {
    const candidate = {
      kind: 'npm_registry' as const,
      version: '2.0.0',
      integrity: INTEGRITY,
    };
    let archivePath = '';
    await withRuntimeHostRegistryUpdateArtifact(
      candidate,
      async (artifact) => {
        archivePath = artifact.archivePath;
        assert.equal((await stat(archivePath)).isFile(), true);
      },
      async (args) => {
        if (args[0] === 'pack') {
          const destination = args[args.indexOf('--pack-destination') + 1]!;
          await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
          return 0;
        }
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const root = join(prefix, 'node_modules', 'maka-agent');
        await Promise.all([
          mkdir(join(root, 'dist'), { recursive: true }),
          mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            join(root, 'package.json'),
            JSON.stringify({ name: 'maka-agent', version: '2.0.0' }),
          ),
          writeFile(join(root, 'dist', 'cli.js'), ''),
          writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
        ]);
        return 0;
      },
    );
    await assert.rejects(stat(archivePath), { code: 'ENOENT' });
  });

  it('revalidates an archive before a coordinator can consume it', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-archive-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const archive = join(root, 'maka.tgz');
    await writeFile(archive, Buffer.from('changed archive'));
    await assert.rejects(
      withVerifiedRuntimeHostUpdateArchive(
        { kind: 'npm_registry', version: '2.0.0', integrity: INTEGRITY },
        archive,
        async () => assert.fail('mismatched archive must not be consumed'),
        async () => assert.fail('mismatched archive must not reach npm'),
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError &&
        error.code === 'package_integrity_mismatch',
    );
  });

  it('binds the official archive to its extracted release evidence', async () => {
    const calls: string[][] = [];
    const candidate = {
      kind: 'npm_registry' as const,
      version: '2.0.0',
      integrity: INTEGRITY,
      compatibility: 7,
    };
    let acquiredRoot = '';
    await withRuntimeHostRegistryUpdatePackage(
      candidate,
      async (root) => {
        acquiredRoot = root;
        assert.equal((await stat(root)).isDirectory(), true);
      },
      async (args) => {
        calls.push([...args]);
        if (args[0] === 'pack') {
          const destination = args[args.indexOf('--pack-destination') + 1]!;
          await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
          return 0;
        }
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const root = join(prefix, 'node_modules', 'maka-agent');
        await Promise.all([
          mkdir(join(root, 'dist'), { recursive: true }),
          mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
            recursive: true,
          }),
        ]);
        await Promise.all([
          writeFile(
            join(root, 'package.json'),
            JSON.stringify({
              name: 'maka-agent',
              version: candidate.version,
              maka: {
                managedRuntimeHostUpdateCompatibility: candidate.compatibility,
              },
            }),
          ),
          writeFile(join(root, 'dist', 'cli.js'), ''),
          writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
        ]);
        return 0;
      },
    );

    assert.deepEqual(calls[0]?.slice(0, 2), ['pack', 'maka-agent@2.0.0']);
    assert.equal(calls[0]?.includes('https://registry.npmjs.org/'), true);
    const downloadCache = calls[0]?.[calls[0].indexOf('--cache') + 1];
    const installCache = calls[1]?.[calls[1].indexOf('--cache') + 1];
    assert.match(downloadCache ?? '', /download-cache$/u);
    assert.match(installCache ?? '', /empty-cache$/u);
    assert.notEqual(downloadCache, installCache);
    assert.equal(calls[1]?.includes('--offline'), true);
    assert.equal(calls[1]?.includes('--ignore-scripts'), true);
    assert.equal(calls[1]?.includes('http://127.0.0.1:9/'), true);
    await assert.rejects(stat(acquiredRoot), { code: 'ENOENT' });
  });

  it('rejects archive or manifest evidence that differs from discovery', async () => {
    let installed = false;
    await assert.rejects(
      withRuntimeHostRegistryUpdatePackage(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        },
        async () => assert.fail('invalid integrity must not expose a package'),
        async (args) => {
          if (args[0] === 'pack') {
            const destination = args[args.indexOf('--pack-destination') + 1]!;
            await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
            return 0;
          }
          installed = true;
          return 0;
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError &&
        error.code === 'package_integrity_mismatch',
    );
    assert.equal(installed, false);

    await assert.rejects(
      withRuntimeHostRegistryUpdatePackage(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: INTEGRITY,
          compatibility: 7,
        },
        async () => assert.fail('invalid manifest must not expose a package'),
        async (args) => {
          if (args[0] === 'pack') {
            const destination = args[args.indexOf('--pack-destination') + 1]!;
            await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
            return 0;
          }
          const prefix = args[args.indexOf('--prefix') + 1]!;
          const root = join(prefix, 'node_modules', 'maka-agent');
          await Promise.all([
            mkdir(join(root, 'dist'), { recursive: true }),
            mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
              recursive: true,
            }),
          ]);
          await Promise.all([
            writeFile(
              join(root, 'package.json'),
              JSON.stringify({
                name: 'maka-agent',
                version: '2.0.0',
                maka: { managedRuntimeHostUpdateCompatibility: 8 },
              }),
            ),
            writeFile(join(root, 'dist', 'cli.js'), ''),
            writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
          ]);
          return 0;
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });

  it('rejects a small verified archive whose headers claim excessive expansion', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-budget-'));
    t.after(() => rm(root, { recursive: true, force: true }));

    // One header claims 4 GiB of entry data inside a tiny compressed archive:
    // integrity still matches, so only the expansion budget can stop it.
    const bloated = tgz([{ name: 'package/blob.bin', body: Buffer.from('x') }]);
    const bloatedHeader = tarHeader('package/huge.bin', 4 * 1024 * 1024 * 1024);
    const oversized = gzipSync(Buffer.concat([bloatedHeader, Buffer.alloc(1024)]));
    const crowded = tgz(
      Array.from({ length: 6 }, (_, index) => ({ name: `package/file-${index}.js` })),
    );

    const oversizedPath = join(root, 'oversized.tgz');
    const crowdedPath = join(root, 'crowded.tgz');
    await Promise.all([
      writeFile(oversizedPath, oversized),
      writeFile(crowdedPath, crowded),
      writeFile(join(root, 'ok.tgz'), bloated),
    ]);

    const budget = { maxExtractedBytes: 1024 * 1024, maxEntries: 5 };
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(oversizedPath, budget),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(crowdedPath, budget),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
    await assertRuntimeHostArchiveExpansionBudget(join(root, 'ok.tgz'), budget);

    // The bound runs before npm ever sees the archive: an integrity-verified
    // but over-budget tarball must not reach the install spawn.
    await assert.rejects(
      withVerifiedRuntimeHostUpdateArchive(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${createHash('sha512').update(oversized).digest('base64')}`,
        },
        oversizedPath,
        async () => assert.fail('over-budget archive must not be consumed'),
        async () => assert.fail('over-budget archive must not reach npm'),
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });

  it('accepts entries whose payload spans multiple gunzip chunks', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-stream-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    // A 128 KiB file entry spans many 16 KiB gunzip chunks; the scanner must
    // carry the payload skip across chunk boundaries instead of reparsing
    // payload bytes as the next header.
    const big = tgz([
      { name: 'package/dist/big.js', body: Buffer.alloc(128 * 1024, 65) },
      { name: 'package/package.json', body: Buffer.from('{"name":"maka-agent"}') },
      { name: 'package/dist/cli.js', body: Buffer.from('#!/usr/bin/env node\n') },
    ]);
    const archive = join(root, 'streamed.tgz');
    await writeFile(archive, big);
    await assertRuntimeHostArchiveExpansionBudget(archive, {
      maxExtractedBytes: 256 * 1024,
      maxEntries: 10,
    });
    // The same archive over the budget by one byte must still be caught once
    // the whole payload has streamed through.
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(archive, {
        maxExtractedBytes: 128 * 1024,
        maxEntries: 10,
      }),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });

  it('fails closed for tar extensions that can reinterpret a raw header size', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-extended-tar-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const type of ['x', 'g', 'X', 'S', 'L', 'K']) {
      const archive = join(root, `${type}.tgz`);
      await writeFile(
        archive,
        tgz([
          { name: 'extended-header', body: Buffer.from('size=4294967296\n'), type },
          { name: 'package/package.json', body: Buffer.from('{"name":"maka-agent"}') },
        ]),
      );
      await assert.rejects(
        assertRuntimeHostArchiveExpansionBudget(archive),
        (error: unknown) =>
          error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
      );
    }
    // This is a syntactically valid POSIX PAX record: its decimal prefix is
    // the record's complete byte length. npm would honor it to reinterpret
    // the following raw tar header, so the staging seam must reject it before
    // it invokes npm at all.
    const pax = tgz([
      { name: 'PaxHeader', body: Buffer.from('19 size=4294967296\n'), type: 'x' },
      { name: 'package/package.json', body: Buffer.from('{"name":"maka-agent"}') },
    ]);
    const paxPath = join(root, 'pax.tgz');
    await writeFile(paxPath, pax);
    let invokedNpm = false;
    await assert.rejects(
      withVerifiedRuntimeHostUpdateArchive(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${createHash('sha512').update(pax).digest('base64')}`,
        },
        paxPath,
        async () => assert.fail('extended tar archive must not be consumed'),
        async () => {
          invokedNpm = true;
          return 0;
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
    assert.equal(invokedNpm, false);
  });

  it('requires two consecutive zero blocks to terminate a tar stream', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-terminator-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const archive = join(root, 'single-zero.tgz');
    await writeFile(
      archive,
      gzipSync(Buffer.concat([tarHeader('package/package.json', 0), Buffer.alloc(512)])),
    );
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(archive),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });

  it('rejects archives that are not readable gzip tarballs', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-update-tarball-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plainPath = join(root, 'plain.tgz');
    const truncatedPath = join(root, 'truncated.tgz');
    await Promise.all([
      writeFile(plainPath, Buffer.from('verified release archive')),
      // A header without its terminating zero blocks.
      writeFile(truncatedPath, gzipSync(tarHeader('package/package.json', 0))),
    ]);
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(plainPath),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
    await assert.rejects(
      assertRuntimeHostArchiveExpansionBudget(truncatedPath),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });
});
