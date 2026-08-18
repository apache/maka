import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflows = resolve(import.meta.dirname, '../.github/workflows');

test('validation consumers download the artifact produced by the build job', () => {
  const workflow = readWorkflow('cli-package-validation.yml');
  assert.match(
    workflow,
    /workflow_call:\n\s+outputs:\n\s+release_candidate_artifact_id:[\s\S]*?value: \$\{\{ jobs\.build\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(
    workflow,
    /release_candidate_artifact_id: \$\{\{ steps\.release-candidate\.outputs\.artifact-id \}\}/u,
  );
  assert.equal(
    occurrences(workflow, 'artifact-ids: ${{ needs.build.outputs.release_candidate_artifact_id }}'),
    2,
  );
});

test('stage consumes the reusable validation artifact identity', () => {
  const workflow = readWorkflow('release-cli-stage.yml');
  assert.match(
    workflow,
    /artifact-ids: \$\{\{ needs\.validate\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.doesNotMatch(workflow, /assert-vacant|git ls-remote/u);
  assert.match(workflow, /RELEASE_RUN_ATTEMPT/u);
});

test('finalize selects and validates one exact stage attempt before checkout', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  assert.match(workflow, /stage_run_attempt:[\s\S]*?required: true/u);
  const loadIndex = workflow.indexOf('id: stage-run');
  const checkoutIndex = workflow.indexOf('uses: actions/checkout@');
  assert.ok(loadIndex >= 0 && checkoutIndex > loadIndex);
  assert.match(workflow, /actions\/runs\/\$STAGE_RUN_ID\/attempts\/\$STAGE_RUN_ATTEMPT/u);
  for (const field of [
    'run.id',
    'run.run_attempt',
    'run.path',
    'run.event',
    'run.head_branch',
    'run.head_sha',
    'run.conclusion',
    'run.head_repository?.full_name',
  ]) {
    assert.ok(workflow.includes(field), `missing pre-check for ${field}`);
  }
});

test('finalize propagates verified artifacts and creates a non-latest exact-tag release', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  assert.match(
    workflow,
    /public_release_artifact_id: \$\{\{ steps\.public-release\.outputs\.artifact-id \}\}/u,
  );
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(
    publish,
    /artifact-ids: \$\{\{ needs\.inspect\.outputs\.public_release_artifact_id \}\}/u,
  );
  assert.match(publish, /--verify-tag/u);
  assert.match(publish, /--prerelease/u);
  assert.match(publish, /--latest=false/u);
  assert.doesNotMatch(publish, /actions\/checkout@/u);
});

test('release workflows select npm from the root packageManager authority', () => {
  for (const name of [
    'cli-package-validation.yml',
    'release-cli-stage.yml',
    'release-cli-finalize.yml',
  ]) {
    const workflow = readWorkflow(name);
    assert.doesNotMatch(workflow, /npm@11\.19\.0/u);
    assert.match(workflow, /packageManager/u);
  }
});

function readWorkflow(name) {
  return readFileSync(resolve(workflows, name), 'utf8');
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
