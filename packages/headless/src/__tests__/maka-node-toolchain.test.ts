import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAKA_NODE_TOOLCHAIN_FINGERPRINT,
  MAKA_NODE_TOOLCHAIN_SPEC,
} from '../maka-node-toolchain.js';

test('Maka container task runs pin a Linux/x64 Node runtime', () => {
  assert.equal(MAKA_NODE_TOOLCHAIN_SPEC.platform, 'linux');
  assert.equal(MAKA_NODE_TOOLCHAIN_SPEC.arch, 'x64');
  assert.equal(MAKA_NODE_TOOLCHAIN_SPEC.node.version, '22.23.1');
  assert.equal(
    MAKA_NODE_TOOLCHAIN_SPEC.node.archiveSha256,
    '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
  );
  assert.equal(
    MAKA_NODE_TOOLCHAIN_SPEC.node.binarySha256,
    '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  );
  assert.match(MAKA_NODE_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
});
