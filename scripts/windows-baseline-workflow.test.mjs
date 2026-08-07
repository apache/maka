import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowUrl = new URL('../.github/workflows/windows-baseline.yml', import.meta.url);
const processIdentityScriptUrl = new URL('./windows-process-identity.ps1', import.meta.url);

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
  assert.match(workflow, /\. \.\/scripts\/windows-process-identity\.ps1/u);
  assert.equal(workflow.match(/Get-WindowsProcessIdentityKey/gmu)?.length, 4);
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

test('Windows process identity matches a non-empty JSON baseline to a live process object', {
  skip: process.platform !== 'win32',
}, () => {
  const fixture = String.raw`
      . '${fileURLToPath(processIdentityScriptUrl).replaceAll("'", "''")}'
      $captured = [pscustomobject]@{
        Processes = @([pscustomobject]@{
          ProcessId = 4242
          CreationDate = [DateTimeOffset]::Parse('2026-08-05T08:09:10.1234567+08:00')
        })
      } | ConvertTo-Json -Depth 3 | ConvertFrom-Json
      $live = [pscustomobject]@{
        ProcessId = 4242
        CreationDate = [DateTime]::Parse('2026-08-05T00:09:10.1234567Z').ToUniversalTime()
      }
      if ((Get-WindowsProcessIdentityKey $captured.Processes) -ne (Get-WindowsProcessIdentityKey $live)) {
        exit 1
      }
    `;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', fixture], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
