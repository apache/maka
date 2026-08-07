import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditWorkflowUrl = new URL('../.github/workflows/dependency-audit.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release-desktop.yml', import.meta.url);

test('dependency audit runs daily and when its security inputs change', async () => {
  const workflow = await readFile(auditWorkflowUrl, 'utf8');

  assert.match(workflow, /^\s+- cron: '17 3 \* \* \*'$/mu);
  assert.match(workflow, /^\s+workflow_dispatch:$/mu);
  assert.match(workflow, /^\s+pull_request:$/mu);
  assert.match(workflow, /^\s+push:\n\s+branches: \[main\]$/mu);
  const pullRequestTrigger = workflow.slice(
    workflow.indexOf('  pull_request:'),
    workflow.indexOf('  push:'),
  );
  assert.match(pullRequestTrigger, /\.github\/workflows\/dependency-audit\.yml/u);
});

test('dependency audit cancels superseded runs for the same ref', async () => {
  const workflow = await readFile(auditWorkflowUrl, 'utf8');

  assert.match(
    workflow,
    /^concurrency:\n  group: dependency-audit-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/mu,
  );
});

test('dependency audit has only read-only repository access', async () => {
  const workflow = await readFile(auditWorkflowUrl, 'utf8');

  assert.equal([...workflow.matchAll(/^\s*permissions:/gmu)].length, 1);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:env|environment):|\$\{\{\s*(?:secrets|vars)\./mu);

  const actionReferences = [...workflow.matchAll(/^\s+uses: [^@\s]+@([^\s#]+)/gmu)].map(
    (match) => match[1],
  );
  assert.ok(actionReferences.length > 0);
  assert.ok(actionReferences.every((reference) => /^[0-9a-f]{40}$/u.test(reference)));
  assert.match(workflow, /^\s+persist-credentials: false$/mu);
});

test('dependency audit installs only production packages without lifecycle scripts', async () => {
  const workflow = await readFile(auditWorkflowUrl, 'utf8');

  assert.match(workflow, /^\s+run: npm ci --ignore-scripts --omit=dev$/mu);
  assert.match(workflow, /^\s+run: npm audit --omit=dev --audit-level=moderate$/mu);
  assert.match(workflow, /^\s+run: npm audit signatures --omit=dev$/mu);
  assert.doesNotMatch(workflow, /^\s+continue-on-error: true$/mu);
});

test('desktop release blocks moderate advisories before signing credentials and packaging', async () => {
  const workflow = await readFile(releaseWorkflowUrl, 'utf8');
  const audit = workflow.indexOf('npm audit --omit=dev --audit-level=moderate');

  assert.notEqual(audit, -1);
  for (const laterStep of [
    'Write App Store Connect API key',
    'Package notarized app and signed DMG',
    'Package the Windows installer and ZIP',
  ]) {
    assert.ok(audit < workflow.indexOf(laterStep), laterStep);
  }
});
