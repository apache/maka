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

/**
 * The script derives its repository root from its own path, so every case here
 * runs a copy of it from `<fixture>/scripts/` and patches `<fixture>`. Nothing
 * touches this repository's `node_modules`, and the real patch-package cases
 * link the installed copy into the fixture instead of installing anything.
 *
 * The two patch-package stubs (missing, failing) stand in for the install
 * states the callers care about; the real-tool cases cover apply, idempotence,
 * and a patch that no longer applies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptName = 'apply-dependency-patches.mjs';
const scriptPath = join(repoRoot, 'scripts', scriptName);

test('root build runs the strict patch gate before its first workspace build', () => {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(rootPackage.scripts.prebuild, 'node scripts/apply-dependency-patches.mjs --strict');
  assert.match(rootPackage.scripts.build, /^npm --workspace @maka\/core run build/u);
});

const realPatchPackageEntry = (() => {
  try {
    return createRequire(import.meta.url).resolve('patch-package/index.js');
  } catch {
    return undefined;
  }
})();

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'maka-apply-dependency-patches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(scriptPath, join(root, 'scripts', scriptName));
  return root;
}

function runScript(root, args = [], env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', scriptName), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function writePatch(root, contents, name = 'fixture-dep+1.0.0.patch') {
  mkdirSync(join(root, 'patches'), { recursive: true });
  writeFileSync(join(root, 'patches', name), contents);
}

/** Stub that records how it was invoked so a case can assert it never ran. */
function writeStubPatchPackage(root, { exitCode = 0, stderr = '' } = {}) {
  const packageDirectory = join(root, 'node_modules', 'patch-package');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    '{"name":"patch-package","version":"0.0.0","main":"index.js"}\n',
  );
  writeFileSync(
    join(packageDirectory, 'index.js'),
    [
      "const { appendFileSync } = require('node:fs');",
      "appendFileSync(process.env.FAKE_PATCH_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
      ...(stderr === '' ? [] : [`process.stderr.write(${JSON.stringify(stderr)});`]),
      `process.exit(${exitCode});`,
      '',
    ].join('\n'),
  );
}

function linkRealPatchPackage(root) {
  const packageDirectory = join(root, 'node_modules', 'patch-package');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(dirname(realPatchPackageEntry), packageDirectory, 'junction');
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeFixtureDependency(root, source) {
  const packageDirectory = join(root, 'node_modules', 'fixture-dep');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","version":"1.0.0","dependencies":{"fixture-dep":"1.0.0"}}\n',
  );
  writeFileSync(
    join(packageDirectory, 'package.json'),
    '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}\n',
  );
  writeFileSync(join(packageDirectory, 'index.js'), source);
  return join(packageDirectory, 'index.js');
}

function writeNestedFixtureDependency(root, source) {
  const packageDirectory = join(root, 'node_modules', '@fixture', 'parent');
  const dependencyDirectory = join(packageDirectory, 'node_modules', 'fixture-dep');
  mkdirSync(dependencyDirectory, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"fixture","version":"1.0.0","dependencies":{"@fixture/parent":"1.0.0"}}\n',
  );
  writeFileSync(
    join(packageDirectory, 'package.json'),
    '{"name":"@fixture/parent","version":"1.0.0","dependencies":{"fixture-dep":"1.0.0"}}\n',
  );
  writeFileSync(
    join(dependencyDirectory, 'package.json'),
    '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}\n',
  );
  const entry = join(dependencyDirectory, 'index.js');
  writeFileSync(entry, source);
  return entry;
}

// Context lines above and below the added line are what make this patch
// idempotent: once applied, the forward hunk no longer matches and
// patch-package recognizes the reverse.
const APPLICABLE_PATCH = [
  'diff --git a/node_modules/fixture-dep/index.js b/node_modules/fixture-dep/index.js',
  'index 1111111..2222222 100644',
  '--- a/node_modules/fixture-dep/index.js',
  '+++ b/node_modules/fixture-dep/index.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '+const patched = true;',
  ' const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

const APPLICABLE_SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

const NESTED_APPLICABLE_PATCH = APPLICABLE_PATCH.replaceAll(
  'node_modules/fixture-dep',
  'node_modules/@fixture/parent/node_modules/fixture-dep',
);

test('postinstall mode skips when patch-package is missing', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);

  const result = runScript(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /patch-package is not installed/u);
  assert.match(result.stderr, /Skipping patches\//u);
});

test('strict mode fails with recovery guidance when patch-package is missing', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);

  const result = runScript(root, ['--strict']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /patch-package is not installed/u);
  assert.match(result.stderr, /npm ci/u);
});

test('an unknown argument is rejected instead of silently skipping patches', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);

  const result = runScript(root, ['--stict']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown argument: --stict/u);
});

test('no patches exit before patch-package is consulted', (t) => {
  const root = createFixture(t);
  mkdirSync(join(root, 'patches'), { recursive: true });
  const log = join(root, 'patch-package.log');

  const result = runScript(root, ['--strict'], { FAKE_PATCH_LOG: log });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(log), false, 'patch-package must not be invoked');
});

test('strict mode forwards --error-on-fail and --error-on-warn', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  const log = join(root, 'patch-package.log');
  writeStubPatchPackage(root);

  const result = runScript(root, ['--strict'], { FAKE_PATCH_LOG: log });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, 'utf8'), '--error-on-fail --error-on-warn\n');
});

test('strict mode reports a failing patch with the recovery command', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  const log = join(root, 'patch-package.log');
  writeStubPatchPackage(root, { exitCode: 1, stderr: 'fixture patch failure\n' });

  const result = runScript(root, ['--strict'], { FAKE_PATCH_LOG: log });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture patch failure/u);
  assert.match(result.stderr, /did not apply cleanly/u);
  assert.match(result.stderr, /npm ci/u);
});

test('default mode fails when a patch no longer applies', (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  const log = join(root, 'patch-package.log');
  writeStubPatchPackage(root, { exitCode: 1 });

  const result = runScript(root, [], { FAKE_PATCH_LOG: log });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not apply cleanly/u);
});

test('the real patch-package applies once and re-running is a no-op', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  const dependencyEntry = writeFixtureDependency(root, APPLICABLE_SOURCE);
  linkRealPatchPackage(root);

  const first = runScript(root, ['--strict']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    readFileSync(dependencyEntry, 'utf8'),
    'const a = 1;\nconst patched = true;\nconst b = 2;\nconst c = 3;\n',
  );

  const appliedHash = hashFile(dependencyEntry);
  const second = runScript(root, ['--strict']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(hashFile(dependencyEntry), appliedHash, 'second run must not re-apply the patch');
});

test('the real patch-package applies a nested dependency patch', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  writePatch(root, NESTED_APPLICABLE_PATCH, '@fixture+parent++fixture-dep+1.0.0.patch');
  const dependencyEntry = writeNestedFixtureDependency(root, APPLICABLE_SOURCE);
  linkRealPatchPackage(root);

  const result = runScript(root, ['--strict']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(dependencyEntry, 'utf8'),
    'const a = 1;\nconst patched = true;\nconst b = 2;\nconst c = 3;\n',
  );
});

test('strict mode rejects a real patch-package version mismatch', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  writeFixtureDependency(root, APPLICABLE_SOURCE);
  writeFileSync(
    join(root, 'node_modules', 'fixture-dep', 'package.json'),
    '{"name":"fixture-dep","version":"1.0.1","main":"index.js"}\n',
  );
  linkRealPatchPackage(root);

  const result = runScript(root, ['--strict']);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /patch file version mismatch/u);
  assert.match(result.stderr, /did not apply cleanly/u);
  assert.match(result.stderr, /regenerate the versioned patch/u);
});

test('strict mode rejects a versioned patch replacement after the prior version applied', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  const v1Patch = join(root, 'patches', 'fixture-dep+1.0.0.patch');
  writePatch(root, APPLICABLE_PATCH);
  const dependencyEntry = writeFixtureDependency(root, APPLICABLE_SOURCE);
  linkRealPatchPackage(root);

  const first = runScript(root, ['--strict']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(readFileSync(dependencyEntry, 'utf8'), /const patched = true;/u);

  rmSync(v1Patch);
  writePatch(root, APPLICABLE_PATCH, 'fixture-dep+1.0.1.patch');

  const replacement = runScript(root, ['--strict']);
  assert.notEqual(replacement.status, 0);
  assert.match(replacement.stdout, /patch file version mismatch/u);
  assert.match(replacement.stderr, /regenerate the versioned patch/u);
});

test('default mode permits a real patch-package version mismatch', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  writeFixtureDependency(root, APPLICABLE_SOURCE);
  writeFileSync(
    join(root, 'node_modules', 'fixture-dep', 'package.json'),
    '{"name":"fixture-dep","version":"1.0.1","main":"index.js"}\n',
  );
  linkRealPatchPackage(root);

  const result = runScript(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patch file version mismatch/u);
});

test('the real patch-package failure reaches the strict guidance', {
  skip: realPatchPackageEntry === undefined ? 'patch-package is not installed' : false,
}, (t) => {
  const root = createFixture(t);
  writePatch(root, APPLICABLE_PATCH);
  writeFixtureDependency(root, 'const c = 3;\nconst b = 2;\nconst a = 1;\n');
  linkRealPatchPackage(root);

  const result = runScript(root, ['--strict']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not apply cleanly/u);
  assert.match(result.stderr, /npm ci/u);
});
