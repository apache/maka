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

describe('script imports of workspace build output', () => {
  // Scripts load built files by path — installed under node_modules or straight
  // out of packages/*/dist — so neither the export maps nor the typechecker
  // notice when a target module stops being emitted. This walks every script
  // and asserts each such literal names a file the build still produces. The
  // dist trees it asserts against are kept fresh by check:stale, which runs
  // ahead of this suite in check:release.
  test('every workspace dist module a script references by path still exists', () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const workspaceDirByPackageName = new Map(
      readdirSync(join(repoRoot, 'packages')).flatMap((directory) => {
        const manifestPath = join(repoRoot, 'packages', directory, 'package.json');
        if (!existsSync(manifestPath)) return [];
        return [[JSON.parse(readFileSync(manifestPath, 'utf8')).name, directory]];
      }),
    );
    const scriptPaths = [];
    const collectScripts = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collectScripts(path);
        else if (/\.(?:mjs|cjs|js)$/u.test(entry.name)) scriptPaths.push(path);
      }
    };
    collectScripts(join(repoRoot, 'scripts'));
    const targets = new Map();
    for (const scriptPath of scriptPaths) {
      const source = readFileSync(scriptPath, 'utf8');
      for (const [literal, packageName, distPath] of source.matchAll(
        /['"`]node_modules\/(@maka\/[^/'"`]+)\/(dist\/[^'"`]+\.js)['"`]/gu,
      )) {
        const workspaceDir = workspaceDirByPackageName.get(packageName);
        assert.ok(workspaceDir, `${literal} in ${scriptPath} names an unknown workspace package`);
        targets.set(
          join(repoRoot, 'packages', workspaceDir, distPath),
          `${scriptPath}: ${literal}`,
        );
      }
      for (const [literal, workspaceDir, distPath] of source.matchAll(
        /['"`](?:\.\.\/)*packages\/([^/'"`]+)\/(dist\/[^'"`]+\.js)['"`]/gu,
      )) {
        assert.ok(
          existsSync(join(repoRoot, 'packages', workspaceDir)),
          `${literal} in ${scriptPath} names an unknown workspace directory`,
        );
        targets.set(
          join(repoRoot, 'packages', workspaceDir, distPath),
          `${scriptPath}: ${literal}`,
        );
      }
    }
    assert.ok(targets.size > 0, 'expected scripts to reference workspace dist files');
    for (const [builtPath, reference] of targets) {
      assert.ok(existsSync(builtPath), `${reference} names a module the build no longer emits`);
    }
  });
});
