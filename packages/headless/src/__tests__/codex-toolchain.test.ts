import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  CODEX_DEEPSEEK_MODEL_CATALOG_FINGERPRINT,
  CODEX_TOOLCHAIN_FINGERPRINT,
  CODEX_TOOLCHAIN_SPEC,
} from '../codex-toolchain.js';

test('Codex toolchain pins the official linux/x64 CLI package and runtime files', async () => {
  assert.equal(CODEX_TOOLCHAIN_SPEC.codex.version, '0.144.6');
  assert.equal(
    CODEX_TOOLCHAIN_SPEC.codex.archiveIntegrity,
    'sha512-4E7EnzCg0OnBxCyYnwJ+qnZwWHYe0YScr5ucKWbngE9u4+0XrpWELqq2Kn9jl5GZK8MDjU7PrJwFIwusHOHjuw==',
  );
  assert.deepEqual(CODEX_TOOLCHAIN_SPEC.codex.files, {
    binary: 'a31ae9450a26216eb1e7c53102fd42123dd675974310b0e2ca3aa4cb622a2c15',
    codeModeHost: 'b3c1b98e0272ed4bff2bf0459574ff5489dee3087149648e43b1b665a76373e1',
    ripgrep: 'ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2',
    bubblewrap: '7df960565a0dece99240ea4b9d0e011307817f9f3b73176c7b71fda44fe84765',
    zsh: '67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3',
    packageMetadata: '4415fcb6e062b567abf79960dbbd38f046ce3c8fbb1170e35fd8129d476126d8',
  });
  assert.match(CODEX_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
  const catalog = await readFile(
    resolve(import.meta.dirname, '../../harbor/deepseek-codex-models.json'),
  );
  assert.equal(
    CODEX_DEEPSEEK_MODEL_CATALOG_FINGERPRINT,
    `sha256:${createHash('sha256').update(catalog).digest('hex')}`,
  );
});
