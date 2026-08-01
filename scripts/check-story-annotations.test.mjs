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

// The three shapes that reach a browser as a real story but do not match
// STORY_EXPORT. Each used to be waved through, which is the exact failure the
// "fail on what you cannot parse" rule exists to prevent.
for (const [shape, source] of [
  ['a plain const', 'export const Sneaky = { render: () => null };'],
  ['a re-export', 'const Sneaky: Story = {};\nexport { Sneaky };'],
  ['an async function', 'export async function Sneaky() {}'],
]) {
  test(`${shape} export fails instead of being skipped`, () => {
    const problems = problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能.
${source}
`);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Sneaky is not `export const <Name>: Story = …`/);
  });
}

// `export const X: Story =` wrapping onto the next line is the same story, and
// a guard that reddens on formatting teaches people to ignore it.
test('a story whose initializer wraps to the next line passes', () => {
  assert.deepEqual(
    problemsFor(`${PRODUCT_META}
// Real path: sidebar → 扩展 → 技能.
export const Wrapped: Story =
  { render: () => null };
`),
    [],
  );
});

// A fixture with its own `title` sits above meta as often as below it, and
// `Design System/…` in one would exempt the whole file.
test('a fixture title above meta does not decide the file namespace', () => {
  const problems = problemsFor(`const fixture = { title: 'Design System/Fake' };
${PRODUCT_META}
export const Sneaky: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Sneaky has no `\/\/ Real path:` comment/);
});

test('an empty `// Real path:` is not an annotation', () => {
  const problems = problemsFor(`${PRODUCT_META}
// Real path:
export const Bare: Story = { render: () => null };
`);
  assert.equal(problems.length, 1);
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

const BOTH_ROOTS =
  "stories: ['../../../packages/ui/stories/**/*.stories.@(ts|tsx)', " +
  "resolve(REPO_ROOT, 'apps/desktop/stories/**/*.stories.@(ts|tsx)')]";

function rootProblems(config) {
  const problems = [];
  checkStorybookRoots(config, problems);
  return problems;
}

test('the config this repo actually ships is accepted', () => {
  assert.deepEqual(rootProblems(BOTH_ROOTS), []);
});

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
