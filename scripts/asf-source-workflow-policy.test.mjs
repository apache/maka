import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const workflowPath = join(import.meta.dirname, '../.github/workflows/asf-source-candidate.yml');

describe('ASF source workflow policy', () => {
  test('binds the candidate handoff to the dispatched commit and artifact', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(workflow, /RELEASE_SHA/);
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /--revision "\$GITHUB_SHA"/);
    assert.match(workflow, /Commit: \\`\$GITHUB_SHA\\`/);
    assert.match(workflow, /tar -xzf "\$CANDIDATE_PATH"/);
    assert.match(workflow, /npm run check:third-party-notices/);
    assert.match(workflow, /npm run check:cli-third-party-notices/);
    assert.match(workflow, /npm run check:windows-cargo-notices/);
    assert.doesNotMatch(workflow, /rc_number/);
    assert.match(workflow, /name: apache-maka-.*-incubating-\$\{\{ github\.sha \}\}-unsigned/);
    assert.match(workflow, /\$\{\{ env\.CANDIDATE_PATH \}\}\.sha512/);
    assert.match(
      workflow,
      /RUNBOOK_URL: .*\/blob\/\$\{\{ github\.sha \}\}\/\.github\/ASF_SOURCE_RELEASE\.md/,
    );
  });

  test('audits source headers in the extracted candidate before it is installed into', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const auditIndex = workflow.indexOf('npm run check:asf-headers');
    const installIndex = workflow.indexOf('npm ci');
    assert.notEqual(auditIndex, -1);
    assert.notEqual(installIndex, -1);
    assert.ok(
      auditIndex < installIndex,
      'the header audit must read the extracted archive, not a built tree',
    );
    assert.match(
      workflow,
      /Audit source headers in the extracted candidate\n\s+working-directory: candidate-source\n/,
    );
  });
});
