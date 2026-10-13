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

import { strict as assert } from 'node:assert';
import { spawnSync as runProcess } from 'node:child_process';
import { createHash as hash, randomUUID as uuid } from 'node:crypto';
import * as files from 'node:fs/promises';
import { tmpdir as temporaryDirectory } from 'node:os';
import { dirname as parentDirectory, join as joinPath } from 'node:path';
import { fileURLToPath as pathFromFileUrl } from 'node:url';
import { test as verify } from 'node:test';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import * as candidateStartup from '../control/startup-diagnostic.js';
const candidateEntrypointUrl = new URL('../execution-candidate-main.js', import.meta.url);
const CANDIDATE_ENTRYPOINT = pathFromFileUrl(candidateEntrypointUrl);
const ROOT_ID = Array.from({ length: 64 }, () => 'a').join('');
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';
const runCandidate = (args: readonly string[]) =>
  runProcess(process.execPath, [CANDIDATE_ENTRYPOINT, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });

verify(
  'execution imports happen after local admission and are skipped by losing candidates',
  async () => {
    const root = await files.mkdtemp(joinPath(temporaryDirectory(), 'maka-candidate-import-'));
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
    const executionModule = new URL('../server/execution-composition.js', import.meta.url).href;
    // Replace the expensive module with an import that checks the externally
    // observable listener before failing. An eager import fails before the
    // candidate's startup error handling or owner election is installed.
    const probe = `
    import nodeAssert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { connect } from 'node:net';
    const registration = JSON.parse(await readFile(${JSON.stringify(joinPath(controlDirectory, 'registration.json'))}, 'utf8'));
    nodeAssert.equal(registration.state, 'recovering');
    await new Promise((resolve, reject) => {
      const socket = connect(registration.endpoint);
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolve(); });
    });
    console.log('listener reachable before execution import');
    throw new Error('injected execution import failure');
    export const createExecutionRuntimeHostComposition = undefined;
  `;
    const bootstrap = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      return url === ${JSON.stringify(executionModule)}
        ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(probe)} }
        : nextLoad(url, context);
    } });
    process.argv.splice(1, 0, ${JSON.stringify(CANDIDATE_ENTRYPOINT)});
    await import(${JSON.stringify(new URL('../execution-candidate-main.js', import.meta.url).href)});
  `;
    const run = (startupAttemptId: string) =>
      runProcess(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          bootstrap,
          '--',
          '--root',
          root,
          '--expected-root-id',
          capability.rootId,
          '--startup-attempt-id',
          startupAttemptId,
        ],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true },
      );
    try {
      const winner = run(uuid());
      assert.equal(winner.status, 70, winner.stderr);
      assert.match(winner.stdout, /listener reachable before execution import/u);
      assert.match(winner.stderr, /\[runtime-host\] startup failed:/u);
      assert.match(winner.stderr, /injected execution import failure/u);

      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      try {
        const loserAttemptId = uuid();
        const loser = run(loserAttemptId);
        assert.equal(loser.status, 2, loser.stderr);
        assert.equal(loser.stderr, '');
        assert.equal(loser.stdout, '');
        // A losing candidate must leave the startup diagnostic the failure
        // paths write: a silent exit left nothing on disk, which is what made
        // replacement storms undiagnosable (issue #5843).
        const loserDiagnostic = await candidateStartup.readCandidateStartupDiagnostic(
          capability.rootId,
          loserAttemptId,
        );
        assert.ok(loserDiagnostic);
        assert.deepEqual({ reason: loserDiagnostic.reason }, { reason: 'launch_election_lost' });
        assert.match(loserDiagnostic.errorChain[0].message, /launch election/u);
      } finally {
        await owner.close();
      }
    } finally {
      await files.rm(root, { recursive: true, force: true });
      await files.rm(controlDirectory, { recursive: true, force: true });
    }
  },
);

verify(
  'candidate entry does not evaluate the Host kernel or domain composition before bootstrap runs',
  () => {
    const candidateEntry = new URL('../candidate-entry.js', import.meta.url).href;
    const kernelModule = new URL('../server/host-kernel.js', import.meta.url).href;
    const domainCompositionModule = new URL('../server/host-composition.js', import.meta.url).href;
    const bootstrap = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      return url === ${JSON.stringify(kernelModule)} || url === ${JSON.stringify(domainCompositionModule)}
        ? { format: 'module', shortCircuit: true, source: "throw new Error('heavy Host module loaded eagerly')" }
        : nextLoad(url, context);
    } });
    await import(${JSON.stringify(candidateEntry)});
  `;
    const result = runProcess(process.execPath, ['--input-type=module', '-e', bootstrap], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
  },
);

function verifyParserFailureBoundary() {
  const validInvocation = Object.entries({
    root: '/tmp/workspace',
    'expected-root-id': ROOT_ID,
    'startup-attempt-id': STARTUP_ATTEMPT_ID,
  }).flatMap(([flag, value]) => [`--${flag}`, value]);
  const invalidSuffixes = new Map<readonly string[], RegExp>([
    [['--desktop-e2e', '1'], /Invalid Runtime Host candidate argument: --desktop-e2e/],
    [['--idle-grace-ms'], /Invalid Runtime Host candidate arguments/],
  ]);
  for (const [suffix, message] of invalidSuffixes) {
    const result = runCandidate(validInvocation.concat(suffix));
    assert.deepEqual(
      {
        status: result.status,
        crossedBoundary: /\[runtime-host\] startup failed:/.test(result.stderr),
      },
      { status: 70, crossedBoundary: true },
      result.stderr,
    );
    assert.match(result.stderr, message);
  }
}
verify(
  'maps every parser failure to the candidate startup-failure boundary',
  verifyParserFailureBoundary,
);

async function verifyDetachedStartupDiagnostic() {
  const root = await files.mkdtemp(joinPath(temporaryDirectory(), 'maka-candidate-diagnostic-'));
  const mismatchedRootId = hash('sha256').update(uuid()).digest('hex');
  const startupAttemptId = uuid();
  const diagnosticPath = candidateStartup.resolveCandidateStartupDiagnosticPath(
    mismatchedRootId,
    startupAttemptId,
  );
  const controlDirectory = parentDirectory(diagnosticPath);
  try {
    await resolveStorageRoot({ path: root, kind: 'interactive' });
    await files.mkdir(controlDirectory, { recursive: true, mode: 0o700 });
    const result = runCandidate([
      '--root',
      root,
      '--expected-root-id',
      mismatchedRootId,
      '--startup-attempt-id',
      startupAttemptId,
    ]);
    assert.deepEqual({ status: result.status }, { status: 70 }, result.stderr);
    const diagnostic = await candidateStartup.readCandidateStartupDiagnostic(
      mismatchedRootId,
      startupAttemptId,
    );
    assert.ok(diagnostic);
    assert.deepEqual(
      { reason: diagnostic.reason, startupAttemptId: diagnostic.startupAttemptId },
      { reason: 'internal_startup_failure', startupAttemptId },
    );
    assert.ok(diagnostic.logs.every((entry) => !entry.includes('startup failed')));
    assert.ok(diagnostic.errorChain.some((entry) => entry.code === 'root_identity_changed'));
  } finally {
    await files.rm(root, { recursive: true, force: true });
    await files.rm(controlDirectory, { recursive: true, force: true });
  }
}

verify(
  'preserves a valid Candidate invocation failure across the detached stderr boundary',
  verifyDetachedStartupDiagnostic,
);

/**
 * Release packaging drops every `test-only/` module, so the production
 * candidate entry must not be able to reach one — statically, not merely at
 * runtime. Walk the built module graph across the bundled `@maka/*` packages
 * and report every test-only module it can reach.
 */
verify('the production candidate entry never reaches a test-only module', async () => {
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
      source = await files.readFile(new URL(current), 'utf8');
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
