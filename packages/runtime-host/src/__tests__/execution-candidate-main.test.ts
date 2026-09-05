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
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  readCandidateStartupDiagnostic,
  resolveCandidateStartupDiagnosticPath,
} from '../control/startup-diagnostic.js';

const CANDIDATE_ENTRYPOINT = fileURLToPath(
  new URL('../execution-candidate-main.js', import.meta.url),
);
const ROOT_ID = 'a'.repeat(64);
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';

test('classifies invalid candidate arguments as an internal startup failure', () => {
  const result = spawnSync(
    process.execPath,
    [
      CANDIDATE_ENTRYPOINT,
      '--root',
      '/tmp/workspace',
      '--expected-root-id',
      ROOT_ID,
      '--startup-attempt-id',
      STARTUP_ATTEMPT_ID,
      '--desktop-e2e',
      '1',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );

  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /\[runtime-host\] startup failed:/);
  assert.match(result.stderr, /Invalid Runtime Host candidate argument: --desktop-e2e/);
});

test('preserves a valid Candidate invocation failure across the detached stderr boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-candidate-diagnostic-'));
  const mismatchedRootId = createHash('sha256').update(randomUUID()).digest('hex');
  const startupAttemptId = randomUUID();
  const diagnosticPath = resolveCandidateStartupDiagnosticPath(mismatchedRootId, startupAttemptId);
  const controlDirectory = dirname(diagnosticPath);
  try {
    await resolveStorageRoot({ path: root, kind: 'interactive' });
    await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [
        CANDIDATE_ENTRYPOINT,
        '--root',
        root,
        '--expected-root-id',
        mismatchedRootId,
        '--startup-attempt-id',
        startupAttemptId,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    assert.equal(result.status, 70, result.stderr);
    const diagnostic = await readCandidateStartupDiagnostic(mismatchedRootId, startupAttemptId);
    assert.ok(diagnostic);
    assert.equal(diagnostic.reason, 'internal_startup_failure');
    assert.equal(diagnostic.startupAttemptId, startupAttemptId);
    assert.ok(diagnostic.logs.every((entry) => !entry.includes('startup failed')));
    assert.ok(diagnostic.errorChain.some((entry) => entry.code === 'root_identity_changed'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(controlDirectory, { recursive: true, force: true });
  }
});

/**
 * Release packaging drops every `test-only/` module, so the production
 * candidate entry must not be able to reach one — statically, not merely at
 * runtime. Walk the built module graph across the bundled `@maka/*` packages
 * and report every test-only module it can reach.
 */
test('the production candidate entry never reaches a test-only module', async () => {
  const entry = new URL('../execution-candidate-main.js', import.meta.url).href;
  const seen = new Set<string>([entry]);
  const queue: string[] = [entry];
  const reached: string[] = [];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (current.includes('/test-only/')) {
      reached.push(current);
      continue;
    }
    let source: string;
    try {
      source = await readFile(new URL(current), 'utf8');
    } catch {
      continue;
    }
    for (const specifier of staticImportSpecifiers(source)) {
      const resolved = resolveModule(specifier, current);
      if (resolved === undefined || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }

  assert.deepEqual(reached, []);
  assert.ok(seen.size > 50, `module graph looks truncated: ${seen.size} modules`);
});

function resolveModule(specifier: string, parent: string): string | undefined {
  try {
    if (specifier.startsWith('.')) return new URL(specifier, parent).href;
    if (specifier.startsWith('@maka/')) {
      const resolved = import.meta.resolve(specifier);
      return resolved.startsWith('file:') ? resolved : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /(?:^|[\s;}])(?:import|export)\b[^'"();]*?from\s*['"]([^'"]+)['"]/g,
  )) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  // Literal dynamic imports are real edges in the shipped graph — the built
  // `dist` already contains several — so a walk that ignored them could pass
  // while a production module reached test-only material through `import(…)`.
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}
