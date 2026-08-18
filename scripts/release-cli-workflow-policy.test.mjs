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
  const downloads = workflowSteps(workflow).filter((step) =>
    step.includes('uses: actions/download-artifact@'),
  );
  assert.ok(downloads.length > 0);
  for (const step of downloads) {
    assert.match(
      step,
      /artifact-ids: \$\{\{ needs\.build\.outputs\.release_candidate_artifact_id \}\}/u,
    );
  }
});

test('stage consumes the validated artifact and makes provenance staging the final step', () => {
  const workflow = readWorkflow('release-cli-stage.yml');
  const steps = workflowSteps(workflow);
  const download = namedStep(steps, 'Download the validated release candidate');
  assert.match(
    download,
    /artifact-ids: \$\{\{ needs\.validate\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(workflow, /RELEASE_RUN_ATTEMPT/u);
  const guidance = namedStep(steps, 'Record the post-staging approval step');
  assert.match(guidance, /if \[\[ "\$RELEASE_DIST_TAG" == "latest" \]\]/u);
  assert.match(guidance, /npm dist-tag add/u);
  const submit = namedStep(steps, 'Submit the candidate to npm staging');
  assert.equal(steps.at(-1), submit);
  assert.match(submit, /npm stage publish/u);
  assert.match(submit, /--provenance/u);
});

test('finalize validates one exact stage attempt before running the current verifier', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
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
  const checkout = namedStep(steps, 'Check out the current release verifier');
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(checkout, /steps\.stage-run\.outputs\.source_sha/u);
});

test('finalize propagates verified artifacts and idempotently publishes an exact-tag release', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  assert.match(
    workflow,
    /public_release_artifact_id: \$\{\{ steps\.public-release\.outputs\.artifact-id \}\}/u,
  );
  assert.match(workflow, /tarball: \$\{\{ steps\.release\.outputs\.tarball \}\}/u);
  assert.doesNotMatch(workflow, /steps\.registry\.outputs\.tarball/u);
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(
    publish,
    /artifact-ids: \$\{\{ needs\.inspect\.outputs\.public_release_artifact_id \}\}/u,
  );
  assert.match(publish, /--verify-tag/u);
  assert.match(publish, /gh release create[\s\S]*?--draft/u);
  assert.match(publish, /gh release upload[\s\S]*?--clobber/u);
  assert.match(publish, /gh release edit[\s\S]*?--draft=false/u);
  assert.match(publish, /gh release view[\s\S]*?--json apiUrl/u);
  assert.match(publish, /gh api "\$release_api_url"/u);
  assert.doesNotMatch(publish, /releases\/tags\/\$RELEASE_TAG/u);
  assert.match(publish, /--prerelease/u);
  assert.match(publish, /--latest=false/u);
  assert.match(publish, /validate-github-release/u);
  const checkout = namedStep(workflowSteps(publish), 'Check out the current release finalizer');
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(checkout, /persist-credentials: false/u);
});

test('release workflows select npm from the root packageManager authority', () => {
  for (const name of [
    'cli-package-validation.yml',
    'release-cli-stage.yml',
    'release-cli-finalize.yml',
  ]) {
    const workflow = readWorkflow(name);
    assert.doesNotMatch(workflow, /npm@11\.19\.0/u);
    const selectors = workflowSteps(workflow).filter((step) =>
      /name: Select the .*npm toolchain/u.test(step),
    );
    assert.ok(selectors.length > 0, `${name} has no npm toolchain selector`);
    for (const step of selectors) {
      assert.match(step, /require\("\.\/package\.json"\)\.packageManager/u);
    }
  }
});

function readWorkflow(name) {
  return readFileSync(resolve(workflows, name), 'utf8');
}

function workflowSteps(workflow) {
  const starts = [...workflow.matchAll(/^      - (?=name:|uses:)/gmu)].map((match) => match.index);
  return starts.map((start, index) => workflow.slice(start, starts[index + 1]));
}

function namedStep(steps, name) {
  const step = steps.find((candidate) => candidate.startsWith(`      - name: ${name}\n`));
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}
