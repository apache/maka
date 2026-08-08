import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { REASONIX_TOOLCHAIN_FINGERPRINT, REASONIX_TOOLCHAIN_SPEC } from '../reasonix-toolchain.js';

describe('Reasonix toolchain', () => {
  test('binds the fingerprint to the extracted binaries and rejects a self-signed cache', async () => {
    assert.equal(
      (REASONIX_TOOLCHAIN_SPEC.node as { binarySha256?: string }).binarySha256,
      '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
    );
    assert.equal(
      (REASONIX_TOOLCHAIN_SPEC.reasonix as { binarySha256?: string }).binarySha256,
      'f2840b5e8401d45f809dceaaea9b4540c2a946c79dcd640d2db7a79021c8a474',
    );
    const root = await mkdtemp(join(tmpdir(), 'maka-reasonix-toolchain-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir);
      await writeFile(join(binDir, 'node'), 'pinned node\n');
      await writeFile(join(binDir, 'reasonix'), 'pinned reasonix\n');
      await chmod(join(binDir, 'node'), 0o755);
      await chmod(join(binDir, 'reasonix'), 0o755);
      const files = {
        'bin/node': sha256('pinned node\n'),
        'bin/reasonix': sha256('pinned reasonix\n'),
      };
      await writeFile(
        join(root, 'manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            fingerprint: REASONIX_TOOLCHAIN_FINGERPRINT,
            spec: REASONIX_TOOLCHAIN_SPEC,
            files,
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(root, 'checksums.sha256'),
        Object.entries(files)
          .map(([path, hash]) => `${hash}  ${path}\n`)
          .join(''),
      );

      const { validatePreparedReasonixToolchain } = await import('../reasonix-toolchain.js');
      await assert.rejects(validatePreparedReasonixToolchain(root), /bin\/node SHA-256 mismatch/);
      assert.match(await readFile(join(root, 'manifest.json'), 'utf8'), /1\.19\.4/);

      // A cache prepared under a different spec must be refused before its own
      // checksums are consulted, or a stale toolchain silently passes off as
      // this one and the arms stop being comparable.
      await writeFile(
        join(root, 'manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            fingerprint: `sha256:${'0'.repeat(64)}`,
            spec: REASONIX_TOOLCHAIN_SPEC,
            files,
          },
          null,
          2,
        )}\n`,
      );
      await assert.rejects(validatePreparedReasonixToolchain(root), /fingerprint mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
