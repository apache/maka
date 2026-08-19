import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  collectWorkspaceDependencyClosure,
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
  orderWorkspaceBuilds,
  resolveWorkspaceReleaseFiles,
  workspaceReleaseFiles,
} from './release-cli-file-policy.mjs';

describe('CLI release file policy', () => {
  test('derives the runtime workspace build order from production dependencies', () => {
    const manifests = new Map([
      ['maka-agent', { name: 'maka-agent', dependencies: { '@maka/eval': '0.1.0' } }],
      ['@maka/eval', { name: '@maka/eval', dependencies: { '@maka/core': '0.1.0' } }],
      ['@maka/core', { name: '@maka/core' }],
    ]);

    assert.deepEqual(collectWorkspaceDependencyClosure('maka-agent', manifests), [
      '@maka/core',
      '@maka/eval',
      'maka-agent',
    ]);
  });

  test('orders selected runtime workspaces by local build-time dependencies', () => {
    const selected = [
      { name: '@maka/runtime', manifest: { devDependencies: { '@maka/storage': '0.1.0' } } },
      { name: '@maka/storage', manifest: {} },
      { name: 'maka-agent', manifest: { dependencies: { '@maka/runtime': '0.1.0' } } },
    ];

    assert.deepEqual(orderWorkspaceBuilds(selected), [
      '@maka/storage',
      '@maka/runtime',
      'maka-agent',
    ]);
  });

  test('release file declarations cannot escape or overlap their workspace', () => {
    for (const releaseFiles of [
      ['dist', '../secret'],
      ['dist', 'dist/runtime'],
    ]) {
      assert.throws(
        () => workspaceReleaseFiles({ name: '@maka/example', releaseFiles }),
        /unsafe|overlap/u,
      );
    }
  });

  test('release file declarations reject directories other than dist', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'maka-release-files-'));
    try {
      mkdirSync(join(workspace, 'dist'));
      mkdirSync(join(workspace, 'runtime-assets'));
      assert.throws(
        () =>
          resolveWorkspaceReleaseFiles(workspace, {
            name: '@maka/example',
            releaseFiles: ['dist', 'runtime-assets'],
          }),
        /must be a regular file/u,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

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

  test('rejects Maka test-only modules so no test backend can ship', () => {
    for (const path of [
      'dist/test-only/fake-backend.js',
      'dist/test-only/execution-candidate-e2e-main.js',
      String.raw`dist\test-only\desktop-e2e-execution.js`,
    ]) {
      assert.equal(isMakaDevelopmentArtifact(path), true, path);
    }
    assert.equal(isMakaDevelopmentArtifact('dist/execution-candidate-main.js'), false);
  });

  test('leaves a third-party test-only directory alone', () => {
    assert.equal(isThirdPartyDevelopmentArtifact('dist/test-only/index.js'), false);
  });
});
