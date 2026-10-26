import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGalleryUi } from '../src/lib/inline-gallery-ui';
import { galleryUiCss } from '../../examples/nsh-gallery-ui/css.js';

const root = join(import.meta.dir, '../..');
const shared = join(root, 'examples/nsh-gallery-ui');
const realSources = Object.fromEntries([
  ...readdirSync(shared).filter((name) => /\.(?:ts|tsx|json)$/.test(name))
    .map((name) => [`examples/nsh-gallery-ui/${name}`, readFileSync(join(shared, name), 'utf8')]),
  ['website/demos/palette.ts', readFileSync(join(root, 'website/demos/palette.ts'), 'utf8')],
]);

test('shared UI imports keep module scopes, aliases, re-exports and live token reads', () => {
  const sources = {
    'examples/nsh-gallery-ui/theme.json': '{"cssVars":{}}',
    'website/demos/palette.ts': 'export { current as ui } from "../../examples/nsh-gallery-ui/palette";',
    'examples/nsh-gallery-ui/palette.ts': [
      'import { token as readToken } from "nsh";',
      'import { value as suffix } from "./other";',
      'const value = "own scope";',
      'export function current() { return value + readToken() + suffix; }',
    ].join('\n'),
    'examples/nsh-gallery-ui/other.ts': 'export const value = "other scope";',
  };
  const source = 'import { ui as current } from "./palette";\nreturn current;';
  const code = inlineGalleryUi(source, sources)
    .replace(/^import \* as (\w+) from "nsh";$/gm, 'const $1 = host;')
    .replace('import { setup as __nshGallerySetup } from "nsh:rt";', 'const __nshGallerySetup = setup;');
  let token = ' dark ';
  let applied: string | undefined;
  const current = new Function('host', 'setup', code)(
    { token: () => token },
    (_tailwind: unknown, theme: string) => { applied = theme; },
  );
  expect(current()).toBe('own scope dark other scope');
  token = ' light ';
  expect(current()).toBe('own scope light other scope');
  expect(applied).toBe(sources['examples/nsh-gallery-ui/theme.json']);
});

test('every real palette-based demo can include the shared UI and its theme', () => {
  for (const name of readdirSync(join(root, 'website/demos')).filter((name) => name.endsWith('.tsx'))) {
    const source = readFileSync(join(root, 'website/demos', name), 'utf8');
    const inlined = inlineGalleryUi(source, realSources);
    expect(inlined).not.toMatch(/^import\s.*from\s*["']\.\/palette["']/m);
    if (inlined !== source) {
      expect(inlined).toContain('__nshGallerySetup(null,');
      expect(inlined).not.toMatch(/^import\s.*from\s*["']\.\.\/.*nsh-gallery-ui/m);
    }
  }
});

test('a demo with only native NSH imports stays as written', () => {
  const source = 'import { mount, Text } from "nsh"; mount(() => <Text>hello</Text>);';
  expect(inlineGalleryUi(source, {})).toBe(source);
});

test('HTML and native examples share complete palettes and surface finishes', () => {
  const theme = JSON.parse(readFileSync(join(shared, 'theme.json'), 'utf8'));
  const finishes = JSON.parse(readFileSync(join(shared, 'finishes.json'), 'utf8'));
  expect(Object.keys(theme.cssVars.light).sort()).toEqual(Object.keys(theme.cssVars.dark).sort());
  expect(Object.keys(finishes.light).sort()).toEqual(Object.keys(finishes.dark).sort());
  const css = galleryUiCss(theme, finishes);
  expect(css).toContain(`--nsh-gallery-background: ${theme.cssVars.dark.background};`);
  expect(css).toContain(`--nsh-gallery-background: ${theme.cssVars.light.background};`);
  expect(css).toContain(`--nsh-gallery-finish-card-box-shadow: ${finishes.dark.card.boxShadow};`);
  expect(css).toContain(`--nsh-gallery-finish-card-box-shadow: ${finishes.light.card.boxShadow};`);
  const defined = new Set([...css.matchAll(/(--nsh-gallery-[\w-]+):/g)].map((match) => match[1]));
  for (const reference of css.matchAll(/var\((--nsh-gallery-[\w-]+)/g)) {
    expect(defined.has(reference[1])).toBe(true);
  }
});
