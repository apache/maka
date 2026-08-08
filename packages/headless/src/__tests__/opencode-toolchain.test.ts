import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { OPENCODE_TOOLCHAIN_FINGERPRINT, OPENCODE_TOOLCHAIN_SPEC } from '../opencode-toolchain.js';

describe('OpenCode toolchain', () => {
  test('binds the fingerprint to the extracted binaries and rejects a self-signed cache', async () => {
    assert.equal(
      (OPENCODE_TOOLCHAIN_SPEC.node as { binarySha256?: string }).binarySha256,
      '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
    );
    assert.equal(
      (OPENCODE_TOOLCHAIN_SPEC.opencode as { binarySha256?: string }).binarySha256,
      '0cbfb6de55aa4ce3c74da12d8516376033693a88abca6238c5be32bf98130636',
    );
    const root = await mkdtemp(join(tmpdir(), 'maka-opencode-toolchain-'));
    try {
      const binDir = join(root, 'bin');
      await mkdir(binDir);
      await writeFile(join(binDir, 'node'), 'pinned node\n');
      await writeFile(join(binDir, 'opencode'), 'pinned opencode\n');
      await chmod(join(binDir, 'node'), 0o755);
      await chmod(join(binDir, 'opencode'), 0o755);
      const files = {
        'bin/node': sha256('pinned node\n'),
        'bin/opencode': sha256('pinned opencode\n'),
      };
      await writeFile(
        join(root, 'manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
            spec: OPENCODE_TOOLCHAIN_SPEC,
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

      const { validatePreparedOpenCodeToolchain } = await import('../opencode-toolchain.js');
      await assert.rejects(validatePreparedOpenCodeToolchain(root), /bin\/node SHA-256 mismatch/);
      assert.match(await readFile(join(root, 'manifest.json'), 'utf8'), /1\.17\.18/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
