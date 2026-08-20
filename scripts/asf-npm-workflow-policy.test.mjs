import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/asf-npm-candidate.yml'),
  'utf8',
);

test('ASF npm candidate workflow binds one validated tarball to the source RC without publishing', () => {
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.ok(workflow.includes('if [[ "$RELEASE_REF" != "refs/tags/$source_candidate_tag" ]]'));
  assert.ok(workflow.includes('git cat-file -t "refs/tags/$source_candidate_tag"'));
  assert.ok(workflow.includes('git rev-parse "refs/tags/$source_candidate_tag^{commit}"'));
  assert.match(
    workflow,
    /uses: \.\/\.github\/workflows\/cli-package-validation\.yml[\s\S]*?source_commit: \$\{\{ needs\.authorize\.outputs\.source_commit \}\}/u,
  );
  assert.match(
    workflow,
    /artifact-ids: \$\{\{ needs\.validate\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(workflow, /packages\/cli\/release\/\*\.tgz\.sha512/u);
  assert.match(workflow, /packages\/cli\/release\/\*\.tgz\.asf-candidate\.json/u);
  assert.doesNotMatch(workflow, /id-token: write|npm (?:stage )?publish|npm dist-tag/u);
});
