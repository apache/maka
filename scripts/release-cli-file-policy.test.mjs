/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  collectWorkspaceDependencyClosure,
  isCurrentDevelopmentJavaScript,
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
  orderWorkspaceBuilds,
  renderNpmReadme,
  resolveWorkspaceReleaseFiles,
  workspaceReleaseManifest,
  workspaceReleaseFiles,
} from './release-cli-file-policy.mjs';

test('the npm README receives the canonical WIP disclaimer exactly once', () => {
  const disclaimer = 'Canonical first line.\n\nCanonical final line.\n';
  assert.equal(
    renderNpmReadme('Before\n<!-- ASF-WIP-DISCLAIMER -->\nAfter\n', disclaimer),
    'Before\nCanonical first line.\n\nCanonical final line.\nAfter\n',
  );
  assert.throws(() => renderNpmReadme('No marker\n', disclaimer), /exactly one/u);
});

describe('CLI release file policy', () => {
  test('release manifests omit exports whose targets are excluded from Maka artifacts', () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    for (const [directory, omitted] of Object.entries({
      core: ['./test-only/async-primitives'],
      mcp: ['./test-only/stdio-server'],
      'runtime-host': [
        './test-only/client-capability-host',
        './test-only/execution-candidate-e2e-main',
      ],
      runtime: [
        './test-only/fake-backend',
        './test-only/observation-text-reader',
        './test-only/invocation-fixture',
      ],
    })) {
      const manifestPath = join(repoRoot, 'packages', directory, 'package.json');
      const source = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const projected = workspaceReleaseManifest(source);

      assert.deepEqual(
        Object.keys(source.exports).filter((subpath) => !Object.hasOwn(projected.exports, subpath)),
        omitted,
      );
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), source);
    }
  });

  test('release manifests project conditional exports leaf by leaf', () => {
    const source = {
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
        './fallback': [
          './dist/__tests__/fixture.js',
          { types: './dist/fallback.d.ts', default: './dist/fallback.js' },
        ],
      },
    };
    const original = structuredClone(source);

    assert.deepEqual(workspaceReleaseManifest(source).exports, {
      '.': { default: './dist/index.js' },
      './fallback': [{ default: './dist/fallback.js' }],
    });
    assert.deepEqual(source, original);
  });

  test('release manifests preserve a top-level export target array', () => {
    assert.deepEqual(
      workspaceReleaseManifest({
        exports: [
          './dist/__tests__/fixture.js',
          { types: './dist/index.d.ts', default: './dist/index.js' },
        ],
      }).exports,
      [{ default: './dist/index.js' }],
    );
  });

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

  test('release file declarations accept a declared directory and reject non-regular entries', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'maka-release-files-'));
    try {
      mkdirSync(join(workspace, 'dist'));
      mkdirSync(join(workspace, 'runtime-assets'));
      writeFileSync(join(workspace, 'runtime-assets', 'profile.yml'), 'a: 1');
      // A declared directory is allowed (the whole tree ships) ...
      assert.deepEqual(
        resolveWorkspaceReleaseFiles(workspace, {
          name: '@maka/example',
          releaseFiles: ['dist', 'runtime-assets'],
        }),
        ['dist', 'runtime-assets'],
      );
      // ... but a missing entry is still rejected.
      assert.throws(
        () =>
          resolveWorkspaceReleaseFiles(workspace, {
            name: '@maka/example',
            releaseFiles: ['dist', 'absent'],
          }),
        /release file is missing/u,
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

  test('development packages exclude JavaScript left by deleted sources', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'maka-development-output-'));
    try {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'current.ts'), 'export {}\n');
      assert.equal(isCurrentDevelopmentJavaScript(workspace, 'current.js'), true);
      assert.equal(isCurrentDevelopmentJavaScript(workspace, 'deleted.js'), false);
      assert.equal(
        isCurrentDevelopmentJavaScript(
          workspace,
          'workers\\generated.js',
          new Set(['workers/generated.js']),
        ),
        true,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
