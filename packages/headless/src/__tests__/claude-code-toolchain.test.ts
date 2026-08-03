import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CODE_TOOLCHAIN_FINGERPRINT,
  CLAUDE_CODE_TOOLCHAIN_SPEC,
} from '../claude-code-toolchain.js';

test('Claude Code toolchain pins the official native linux/x64 release', () => {
  assert.deepEqual(CLAUDE_CODE_TOOLCHAIN_SPEC.claudeCode, {
    version: '2.1.220',
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.220/linux-x64/claude',
    sha256: '674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863',
    size: 275_012_592,
  });
  assert.match(CLAUDE_CODE_TOOLCHAIN_FINGERPRINT, /^sha256:[a-f0-9]{64}$/);
});
