import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

// The skills in skills/ are installed on their own (`npx skills add longbridge/nsh`), so they
// carry copies. These keep the copies equal to what they copy, and the skills' own links alive.

const REPO = join(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

test('the skills carry the guides verbatim', () => {
  // After changing a guide: cp website/docs/coding-guides.md skills/nsh/references/ (and the design guide).
  expect(read('skills/nsh/references/coding-guides.md')).toBe(read('website/docs/coding-guides.md'));
  expect(read('skills/nsh-design-guides/references/design-guides.md')).toBe(read('website/docs/design-guides.md'));
});

// The recipes are copies of apps CI builds and tests, file by file.
const walk = (dir: string): string[] =>
  readdirSync(join(REPO, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (['.nsh', 'target', 'tsconfig.json', 'Cargo.lock'].includes(name)) return [];
    return statSync(join(REPO, path)).isDirectory() ? walk(path) : [path];
  });

for (const [example, recipeFile] of [['examples/tasks', 'tsx-recipe.md'], ['examples/tasks-rs', 'rust-recipe.md']]) {
  test(`${recipeFile} shows ${example} as it is`, () => {
    const recipe = read(`skills/nsh/references/${recipeFile}`);
    for (const file of walk(example)) {
      expect(recipe).toContain(`## \`${file.slice(example.length + 1)}\``);
      expect(recipe).toContain(read(file).trimEnd());
    }
  });
}

test("the skills' relative links resolve, and their guide tables name real sections", () => {
  for (const skill of readdirSync(join(REPO, 'skills'))) {
    const text = read(`skills/${skill}/SKILL.md`);
    for (const [, target] of text.matchAll(/\]\((references\/[^)#]+)/g)) {
      expect(existsSync(join(REPO, 'skills', skill, target))).toBe(true);
    }
  }
  const sections = (path: string) => [...read(path).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const [skill, guide] of [['nsh', 'coding-guides'], ['nsh-design-guides', 'design-guides']]) {
    const dir = `skills/${skill}`;
    const skillText = read(`${dir}/SKILL.md`);
    for (const section of sections(`${dir}/references/${guide}.md`)) {
      if (section === 'Make the common path inexpensive') continue;
      expect(skillText).toContain(`| ${section} `);
    }
  }
});

// Mode references are shipped with the skill too. Copied website guides use site-relative
// links, whose base is documented in each entrypoint; their parity is checked above.
test('bundled skill references resolve without a repository checkout', () => {
  for (const skill of readdirSync(join(REPO, 'skills'))) {
    const dir = `skills/${skill}`;
    const root = resolve(REPO, dir);
    for (const file of walk(dir).filter((path) => path.endsWith('.md'))) {
      if (file.endsWith('/coding-guides.md') || file.endsWith('/design-guides.md')) continue;
      for (const [, target] of read(file).matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        const path = resolve(REPO, dirname(file), decodeURIComponent(target.split('#')[0]));
        expect(relative(root, path).startsWith('..')).toBe(false);
        expect(existsSync(path)).toBe(true);
      }
    }
  }
});
