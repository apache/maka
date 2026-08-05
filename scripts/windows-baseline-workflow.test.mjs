import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/windows-baseline.yml', import.meta.url);

test('Windows baseline workflow keeps its non-blocking evidence contract', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^\s+runs-on: windows-latest$/mu);
  assert.match(workflow, /^\s+continue-on-error: true$/mu);
  assert.match(workflow, /^\s+timeout-minutes: 45$/mu);

  const stepIds = [...workflow.matchAll(/^\s+- id: ([a-z]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(stepIds, [
    'install',
    'build',
    'inventory',
    'scripts',
    'smoke',
    'storage',
    'processes',
  ]);
  for (const stepId of stepIds) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ steps\\.${stepId}\\.outcome \\}\\}`, 'u'));
  }

  for (const command of [
    'npm.cmd ci',
    'npm.cmd run build:test',
    'npm.cmd run windows:inventory',
    'npm.cmd run test:scripts',
    'npm.cmd run smoke:windows',
    'node.exe scripts/run-workspace-tests-parallel.mjs --concurrency=1 --workspaces=packages/storage',
  ]) {
    assert.ok(workflow.includes(command), command);
  }

  assert.match(workflow, /Get-CimInstance Win32_Process/u);
  assert.match(workflow, /name: Capture process baseline/u);
  assert.match(workflow, /process-baseline\.json/u);
  assert.match(workflow, /CreationDate/u);
  assert.match(workflow, /HashSet\[string\]/u);
  assert.match(workflow, /HashSet\[int\]/u);
  assert.doesNotMatch(workflow, /CommandLine -match/u);
  assert.match(workflow, /\$treeProcessIds\.Contains\(\$process\.ParentProcessId\)/u);
  assert.match(workflow, /residual-process-tree\.json/u);
  assert.match(workflow, /taskkill\.exe \/PID \$process\.ProcessId \/T \/F/u);
  assert.match(workflow, /residual-processes-after-cleanup\.json/u);
  assert.match(workflow, /\$unreaped\.Count -gt 0/u);
  assert.match(workflow, /\$exitCode = \$LASTEXITCODE/u);
  assert.match(
    workflow,
    /--workspaces=packages\/storage \*> "\$env:WINDOWS_BASELINE_LOG_DIR\/storage\.log"/u,
  );
  assert.match(workflow, /Get-Content "\$env:WINDOWS_BASELINE_LOG_DIR\/storage\.log"/u);
  // Pin-short-comment contract: the workflow must pin upload-artifact to a
  // full SHA and annotate it with the exact version it resolves to. The major
  // is intentionally not asserted — dependabot may bump it — but the
  // annotation must stay truthful.
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/u);
  assert.match(workflow, /name: windows-baseline/u);
  assert.match(workflow, /retention-days: 14/u);
});
