import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
} from './release-cli-file-policy.mjs';

describe('CLI release file policy', () => {
  test('rejects third-party development artifacts on every platform', () => {
    for (const path of [
      'coverage/lcov.info',
      'test/fixture/input.json',
      'lib/parser.test.js',
      'dist/index.d.ts',
      'dist/index.js.map',
      String.raw`fixtures\windows.json`,
      'src/index.ts',
    ]) {
      assert.equal(isThirdPartyDevelopmentArtifact(path), true, path);
    }
  });

  test('preserves third-party runtime source and native assets', () => {
    for (const path of [
      'src/index.js',
      'dist/index.js',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'LICENSE',
      'package.json',
    ]) {
      assert.equal(isThirdPartyDevelopmentArtifact(path), false, path);
    }
  });

  test('keeps the stricter Maka-owned package boundary', () => {
    assert.equal(isMakaDevelopmentArtifact('src/index.js'), true);
    assert.equal(isMakaDevelopmentArtifact('dist/__tests__/fixture.js'), true);
    assert.equal(isMakaDevelopmentArtifact('dist/index.js'), false);
  });
});
