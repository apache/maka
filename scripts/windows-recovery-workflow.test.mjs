import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/windows-recovery.yml', import.meta.url);
const runtimeCrashHarnessUrls = [
  new URL('../packages/runtime/src/__tests__/runtime-resume-crash.test.ts', import.meta.url),
  new URL('../packages/runtime/src/__tests__/runtime-continuation-crash.test.ts', import.meta.url),
];

test('Windows recovery workflow is a bounded release-blocking evidence gate', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^\s+windows_recovery:$/mu);
  assert.match(workflow, /^\s+name: windows_recovery$/mu);
  assert.match(workflow, /^\s+runs-on: windows-latest$/mu);
  assert.match(workflow, /^\s+timeout-minutes: 30$/mu);
  assert.doesNotMatch(workflow, /continue-on-error/u);

  for (const command of ['npm.cmd ci', 'npm.cmd run build:test']) {
    assert.ok(workflow.includes(command), command);
  }

  for (const testArtifact of [
    'packages/storage/dist/__tests__/sqlite-runtime-crash.test.js',
    'packages/storage/dist/__tests__/sqlite-long-term-memory-crash.test.js',
    'packages/runtime/dist/__tests__/runtime-resume-crash.test.js',
    'packages/runtime/dist/__tests__/runtime-continuation-crash.test.js',
    'packages/runtime-host/dist/__tests__/artifact-two-client-uds.test.js',
    'packages/runtime-host/dist/__tests__/execution-host-queue.test.js',
    'packages/storage/dist/__tests__/managed-workspace-baseline.test.js',
    'packages/storage/dist/__tests__/git-workspace-service.test.js',
  ]) {
    assert.ok(workflow.includes(testArtifact), testArtifact);
  }

  assert.match(workflow, /\$env:MAKA_STORAGE_STRESS = '1'/u);
  assert.match(workflow, /owner death\|a killed Host is recovered exactly once/u);
  assert.match(workflow, /real process crash\|real crash\|real-process crash/u);
});

test('Runtime crash harnesses widen only the Windows process budget', async () => {
  for (const harnessUrl of runtimeCrashHarnessUrls) {
    const harness = await readFile(harnessUrl, 'utf8');
    assert.match(
      harness,
      /const CRASH_HARNESS_TIMEOUT_MS = process\.platform === 'win32' \? 120_000 : 60_000;/u,
    );
    assert.match(harness, /timeout: CRASH_HARNESS_TIMEOUT_MS/u);
  }
});
