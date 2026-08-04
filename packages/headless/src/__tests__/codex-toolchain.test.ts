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
  assert.equal(CODEX_TOOLCHAIN_SPEC.codex.version, '0.146.0');
  assert.equal(
    CODEX_TOOLCHAIN_SPEC.codex.archiveIntegrity,
    'sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA==',
  );
  assert.deepEqual(CODEX_TOOLCHAIN_SPEC.codex.files, {
    binary: '2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04',
    codeModeHost: '520e0f7e2c955a591995c4437d6b10c38595c43c94fba39cef4381a00dadcb98',
    ripgrep: 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
    bubblewrap: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
    zsh: '67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3',
    packageMetadata: '3f9cd79076d1747cba97f610475f3ad99be314a15cbf665b8d8f179c020aa353',
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
