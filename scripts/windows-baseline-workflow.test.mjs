import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowUrl = new URL('../.github/workflows/windows-baseline.yml', import.meta.url);
const processIdentityScriptUrl = new URL('./windows-process-identity.ps1', import.meta.url);

function powerShellArgs(command) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
}

function resolvePowerShellExecutable(spawn = spawnSync) {
  const failures = [];
  for (const executable of ['pwsh.exe', 'powershell.exe']) {
    const probe = spawn(executable, powerShellArgs('exit 0'), {
      encoding: 'utf8',
    });
    if (probe.status === 0) return executable;
    failures.push(
      `${executable}: ${probe.error?.message || probe.stderr || probe.stdout || `exit ${probe.status}`}`,
    );
  }
  assert.fail(`No usable PowerShell executable (${failures.join('; ')})`);
}

test('PowerShell resolution covers the documented Windows PowerShell fallback', () => {
  for (const pwshFailure of [
    {
      status: null,
      error: Object.assign(new Error('spawnSync pwsh.exe ENOENT'), { code: 'ENOENT' }),
    },
    { status: 1, error: undefined },
  ]) {
    const calls = [];
    const executable = resolvePowerShellExecutable((command, args, options) => {
      calls.push({ command, args, options });
      return command === 'pwsh.exe'
        ? { ...pwshFailure, stdout: '', stderr: '' }
        : { status: 0, error: undefined, stdout: '', stderr: '' };
    });

    assert.equal(executable, 'powershell.exe');
    assert.deepEqual(
      calls.map(({ command }) => command),
      ['pwsh.exe', 'powershell.exe'],
    );
    assert.deepEqual(calls[0].args, powerShellArgs('exit 0'));
    assert.equal(calls[0].options.encoding, 'utf8');
  }
});

test('Windows baseline workflow keeps its non-blocking evidence contract', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^\s+runs-on: windows-latest$/mu);
  assert.match(workflow, /^\s+continue-on-error: true$/mu);
  assert.match(workflow, /^\s+timeout-minutes: 45$/mu);
  assert.match(workflow, /^\s+needs: changes$/mu);
  assert.match(workflow, /if: needs\.changes\.outputs\.windows == 'true'/u);
  assert.match(workflow, /windows_runtime: \$\{\{ steps\.plan\.outputs\.windows_runtime \}\}/u);
  assert.match(workflow, /windows_storage: \$\{\{ steps\.plan\.outputs\.windows_storage \}\}/u);
  assert.match(
    workflow,
    /windows_storage_full: \$\{\{ steps\.full\.outputs\.windows_storage_full \}\}/u,
  );
  assert.match(workflow, /schedule:\n\s+- cron:/u);
  assert.match(workflow, /full_storage:/u);

  const stepIds = [...workflow.matchAll(/^\s+- id: ([a-z_]+)$/gmu)]
    .map((match) => match[1])
    .filter((stepId) => stepId !== 'plan' && stepId !== 'full');
  assert.deepEqual(stepIds, [
    'install',
    'build',
    'inventory',
    'scripts',
    'smoke',
    'runtime_pty_input',
    'storage',
    'managed_workspace_crash',
    'storage_full',
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
    'npm.cmd --workspace @maka/desktop run build:smoke',
    'npm.cmd run smoke:windows:dist',
    // Curated OS-sensitive gate set for PR/push.
    'node.exe --test --test-concurrency=2 --test-force-exit --test-timeout=60000',
    'packages/storage/dist/__tests__/root-authority.test.js',
    'packages/storage/dist/__tests__/sqlite-recovery-concurrency.test.js',
    'packages/storage/dist/__tests__/managed-workspace-owner.test.js',
    'node.exe --test --test-force-exit --test-timeout=15000 --test-reporter=tap --test-concurrency=1 --test-name-pattern="semantic text and Enter actions|terminal mode parsed before the control cut" packages/runtime/dist/__tests__/shell-run-manager.test.js',
    'node.exe --test --test-concurrency=1 --test-name-pattern="real process crash|real crash|real-process crash|crash after baseline ref publication" packages/storage/dist/__tests__/managed-workspace-baseline.test.js packages/storage/dist/__tests__/git-workspace-service.test.js',
    // Full suite only via storage_full (nightly / manual), not the PR storage step.
    'node.exe scripts/run-workspace-tests-parallel.mjs --concurrency=1 --workspaces=packages/storage',
  ]) {
    assert.ok(workflow.includes(command), command);
  }
  assert.match(workflow, /needs\.changes\.outputs\.windows_storage_full == 'true'/u);
  assert.equal(workflow.match(/needs\.changes\.outputs\.windows_storage == 'true'/gu)?.length, 2);
  assert.equal(workflow.match(/needs\.changes\.outputs\.windows_runtime == 'true'/gu)?.length, 1);
  assert.match(workflow, /Runtime PTY input gate did not run exactly two passing tests/u);
  assert.match(workflow, /name: Capture full storage suite baseline/u);
  assert.match(workflow, /storage-full\.log/u);

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
  assert.match(workflow, /Tee-Object -FilePath "\$env:WINDOWS_BASELINE_LOG_DIR\/storage\.log"/u);
  assert.match(workflow, /name: Run Windows storage path and lock gates/u);
  assert.match(workflow, /\$env:MAKA_STORAGE_STRESS = '1'/u);
  assert.match(workflow, /managed-workspace-crash\.log/u);
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
          CreationDate = [DateTimeOffset]::Parse('2026-08-05T08:09:10.1234567+08:00').ToUniversalTime().ToString('o')
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
  const result = spawnSync(resolvePowerShellExecutable(), powerShellArgs(fixture), {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
