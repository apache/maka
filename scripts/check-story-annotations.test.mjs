import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFile, checkStorybookRoots } from './check-story-annotations.mjs';

function problemsFor(source) {
  const problems = [];
  checkFile('stories/example.stories.tsx', source, problems);
  return problems;
}

const PRODUCT_META = `const meta = { title: 'Product/Example' } satisfies Meta;\n`;

test('a Product story without a Real path comment is reported', () => {
  const problems = problemsFor(`${PRODUCT_META}
export const Annotated: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Annotated has no `\/\/ Real path:` comment/);
});

test('an unsupported export shape fails instead of being skipped', () => {
  const problems = problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能.
export const Sneaky = { render: () => null };
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Sneaky is not `export const <Name>: Story = …`/);
});

test('an empty `// Real path:` is not an annotation', () => {
  const problems = problemsFor(`${PRODUCT_META}
// Real path:
export const Bare: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
});

test('a title in no known namespace is reported rather than silently skipped', () => {
  const problems = problemsFor(`const meta = { title: 'Scratch/Thing' } satisfies Meta;
export const Unannotated: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /neither Product\/\* nor an exempt namespace/);
});

test('a file with no meta title is reported', () => {
  assert.equal(problemsFor('export const Orphan: Story = {};\n').length, 1);
});

const BOTH_ROOTS =
  "stories: ['../../../packages/ui/stories/**/*.stories.@(ts|tsx)', " +
  "resolve(REPO_ROOT, 'apps/desktop/stories/**/*.stories.@(ts|tsx)')]";

function rootProblems(config) {
  const problems = [];
  checkStorybookRoots(config, problems);
  return problems;
}

// Both story roots end in `stories`, so matching only the last path segment
// stays satisfied by whichever root is left and passes in silence.
test('dropping either story root from the Storybook config is caught', () => {
  for (const dropped of ['packages/ui/stories', 'apps/desktop/stories']) {
    const problems = rootProblems(BOTH_ROOTS.replace(`${dropped}/**/*.stories.`, 'elsewhere/'));
    assert.equal(problems.length, 1, dropped);
    assert.match(problems[0], new RegExp(`no longer loads ${dropped}`));
  }
});

// The other direction: a root Storybook loads but this scanner never opens is
// unchecked coverage, which is what the guard claims cannot happen.
test('adding a story root to the Storybook config is caught', () => {
  const problems = rootProblems(
    BOTH_ROOTS.replace(']', ", 'apps/desktop/e2e-stories/**/*.stories.@(ts|tsx)']"),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /loads apps\/desktop\/e2e-stories, which is not in STORY_ROOTS/);
});
