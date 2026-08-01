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

test('an annotation anywhere in the contiguous comment block above counts', () => {
  assert.deepEqual(
    problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能, with skills installed.
// The frame is imported rather than retyped.
export const Annotated: Story = { render: () => null };
`),
    [],
  );
});

test('a blank line between the comment and the export breaks the block', () => {
  const problems = problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能.

export const Detached: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
});

test('an export that is not `export const Name: Story` fails instead of being skipped', () => {
  const problems = problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能.
export const Sneaky = { render: () => null };
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Sneaky is not `export const Sneaky: Story = …`/);
});

test('Primitives/* and Design System/* are exempt', () => {
  for (const title of ['Primitives/Toast', 'Design System/Icons']) {
    assert.deepEqual(
      problemsFor(`const meta = { title: '${title}' } satisfies Meta;
export const Unannotated: Story = { render: () => null };
`),
      [],
    );
  }
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

// Both story roots end in `stories`, so matching only the last path segment
// stays satisfied by whichever root is left and passes in silence.
test('dropping either story root from the Storybook config is caught', () => {
  const both =
    "stories: ['../../../packages/ui/stories/**/*.stories.@(ts|tsx)', " +
    "resolve(REPO_ROOT, 'apps/desktop/stories/**/*.stories.@(ts|tsx)')]";
  assert.deepEqual(checkStorybookRoots(both, []) ?? [], []);

  for (const dropped of ['packages/ui/stories', 'apps/desktop/stories']) {
    const problems = [];
    checkStorybookRoots(both.replace(`${dropped}/**/*.stories.`, 'elsewhere/'), problems);
    assert.equal(problems.length, 1, dropped);
    assert.match(problems[0], new RegExp(`no longer loads ${dropped}`));
  }
});
