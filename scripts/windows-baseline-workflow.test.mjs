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
    'npm ci',
    'npm run build:test',
    'npm run windows:inventory',
    'npm run test:scripts',
    'npm run smoke:windows',
    'node scripts/run-workspace-tests-parallel.mjs --concurrency=1 --workspaces=packages/storage',
  ]) {
    assert.ok(workflow.includes(command), command);
  }

  assert.match(workflow, /Get-CimInstance Win32_Process/u);
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /name: windows-baseline/u);
  assert.match(workflow, /retention-days: 14/u);
});
