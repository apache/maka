import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyKimiCodeRequestTimeoutPatch,
  KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  KIMI_CODE_TOOLCHAIN_SPEC,
} from '../kimi-code-toolchain.js';

test('Kimi Code toolchain pins the official package and extracted entrypoint', () => {
  assert.equal(KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.version, '0.26.0');
  assert.equal(
    KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.archiveIntegrity,
    'sha512-GadxPxbCYOfkMgX8sF6VyuligSTLU81sxJswMtzM5D0vmB7/ZGM7PBmUn6YF2fV/nKcx1JgPIHEc3vgKCQgqsQ==',
  );
  assert.equal(
    KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.sourceEntrypointSha256,
    'bc310a7d2f0c3c2cb1367fa7b2092375351efff51c6d4a358b8681b4a01fb7b0',
  );
  assert.equal(KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.patch.env, 'KIMI_MODEL_REQUEST_TIMEOUT_MS');
  assert.equal(
    KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.entrypointSha256,
    '58f48c418f446e525f2b60765a27221ed7ac771bebed45375a289d1172aa96c6',
  );
  assert.equal(
    KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.packageJsonSha256,
    '65dfa318a882d834e356828d0f371f349f2dcfc99585cb01412f7c0a9e6ae52a',
  );
  assert.match(KIMI_CODE_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
});

test('Kimi Code toolchain patch replaces the OpenAI SDK timeout default used by Kimi chat', () => {
  const anchor = 'OpenAI.DEFAULT_TIMEOUT = 6e5;';
  assert.equal(
    applyKimiCodeRequestTimeoutPatch(`before ${anchor} after`),
    'before OpenAI.DEFAULT_TIMEOUT = Number(process.env["KIMI_MODEL_REQUEST_TIMEOUT_MS"] ?? 6e5); after',
  );
  assert.throws(
    () => applyKimiCodeRequestTimeoutPatch('no OpenAI timeout default'),
    /expected 1 OpenAI SDK timeout default, found 0/,
  );
});
