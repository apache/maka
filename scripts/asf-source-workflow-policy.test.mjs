import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const workflowPath = join(import.meta.dirname, '../.github/workflows/asf-source-candidate.yml');

describe('ASF source workflow policy', () => {
  test('binds build, verification, extraction, and upload to one candidate identity', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    assert.match(workflow, /RELEASE_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /ref: \$\{\{ env\.RELEASE_SHA \}\}/);
    assert.match(workflow, /--revision "\$RELEASE_SHA"/);
    assert.match(workflow, /--artifact "\$CANDIDATE_PATH"/);
    assert.match(workflow, /tar -xzf "\$CANDIDATE_PATH"/);
    assert.match(workflow, /\$\{\{ env\.CANDIDATE_PATH \}\}\.sha512/);
    assert.match(workflow, /run: npm run check:asf-source/);

    const orderedSteps = [
      'Create the unsigned source candidate',
      'Verify archive structure and SHA-512',
      'Extract the exact candidate',
      'Test the extracted source',
      'Upload the verified unsigned candidate',
    ];
    let previousIndex = -1;
    for (const step of orderedSteps) {
      const index = workflow.indexOf(step);
      assert.ok(index > previousIndex, `${step} must preserve the candidate gate order`);
      previousIndex = index;
    }
  });
});
