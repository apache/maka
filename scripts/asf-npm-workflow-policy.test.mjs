import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/asf-npm-candidate.yml'),
  'utf8',
);

test('ASF npm preflight validates the source RC package without publishing', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.ok(workflow.includes('if [[ "$RELEASE_REPOSITORY" != "apache/maka" ]]'));
  assert.match(workflow, /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/u);
  assert.match(workflow, /SOURCE_REFERENCE_TAG: \$\{\{ github\.ref_name \}\}/u);
  assert.ok(workflow.includes('if [[ "$RELEASE_REF" != "refs/tags/$SOURCE_REFERENCE_TAG" ]]'));
  assert.ok(workflow.includes('git cat-file -t "refs/tags/$SOURCE_REFERENCE_TAG"'));
  assert.ok(workflow.includes('git rev-parse "refs/tags/$SOURCE_REFERENCE_TAG^{commit}"'));
  assert.ok(workflow.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main'));
  assert.match(workflow, /node scripts\/product-release-identity\.mjs/u);
  assert.match(
    workflow,
    /uses: \.\/\.github\/workflows\/cli-package-validation\.yml[\s\S]*?source_commit: \$\{\{ github\.sha \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /id-token: write|npm (?:stage )?publish|npm dist-tag|download-artifact|\.sha512|asf-candidate\.json/u,
  );
});
