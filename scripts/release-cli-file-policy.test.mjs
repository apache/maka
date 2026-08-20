import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

describe('CLI release smoke script imports', () => {
  // importInstalled() loads built files by path, so neither the export maps
  // nor the typechecker notice when a target module stops being emitted. The
  // dist trees this asserts against are kept fresh by check:stale, which runs
  // ahead of this suite in check:release.
  test('every workspace module the smoke script imports by path still exists', () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const smokeScript = readFileSync(
      join(repoRoot, 'scripts/smoke-release-cli-package.mjs'),
      'utf8',
    );
    const workspaceDirByPackageName = new Map(
      readdirSync(join(repoRoot, 'packages')).flatMap((directory) => {
        const manifestPath = join(repoRoot, 'packages', directory, 'package.json');
        if (!existsSync(manifestPath)) return [];
        return [[JSON.parse(readFileSync(manifestPath, 'utf8')).name, directory]];
      }),
    );
    const literals = [
      ...smokeScript.matchAll(/'node_modules\/(@maka\/[^/']+)\/(dist\/[^']+\.js)'/gu),
    ];
    assert.ok(literals.length > 0, 'expected the smoke script to import workspace dist files');
    for (const [literal, packageName, distPath] of literals) {
      const workspaceDir = workspaceDirByPackageName.get(packageName);
      assert.ok(workspaceDir, `${literal} names an unknown workspace package`);
      const builtPath = join(repoRoot, 'packages', workspaceDir, distPath);
      assert.ok(
        existsSync(builtPath),
        `${literal} imports a module the build no longer emits: ${builtPath}`,
      );
    }
  });
});
