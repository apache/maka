import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inlineGalleryUi } from '../src/lib/inline-gallery-ui';
import { galleryUiCss } from '../../examples/nsh-gallery-ui/css.js';

const root = join(import.meta.dir, '../..');
const shared = join(root, 'examples/nsh-gallery-ui');
// As the playground collects them: every module of the shared UI, its
// subdirectories (`look/`) included, but its tests.
const realSources = Object.fromEntries([
  ...readdirSync(shared, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx|json)$/.test(name) && !name.startsWith('tests/') && !name.split('/').some((part) => part.startsWith('.')))
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

test('the shared looks in look/ inline with the demos that use them', () => {
  const source = 'import { buttonLook, buttonLabel, iconButtonLook } from "./palette";\nmount(() => null);';
  const inlined = inlineGalleryUi(source, realSources);
  // look/button.ts is its own scope, reached through demo.ts's re-exports.
  expect(inlined).toContain('const TOUCH_TARGET = 44;');
  expect(inlined).toMatch(/buttonLook: __nshGalleryModule\d+\.buttonLook/);
  expect(inlined).toContain('const { buttonLook: buttonLook, buttonLabel: buttonLabel, iconButtonLook: iconButtonLook } =');
});

test('the menu and overlay looks inline with their parts and the popup surface', () => {
  const source = 'import { backdrop, MenuPanel, menuItemLook, popoverLook, SubmenuRow, toastActionLook } from "./palette";\nmount(() => null);';
  const inlined = inlineGalleryUi(source, realSources);
  // look/menu.tsx and look/overlay.ts are scopes of their own, with the
  // popup surface, the icons and the button look they build on.
  expect(inlined).toContain('function MenuPanel(');
  expect(inlined).toContain('function popoverLook(');
  expect(inlined).toContain('const popupSurface = ');
  expect(inlined).toMatch(/menuItemLook: __nshGalleryModule\d+\.menuItemLook/);
  expect(inlined).toMatch(/backdrop: __nshGalleryModule\d+\.backdrop/);
  expect(inlined).not.toMatch(/^(?:import|export)\s.*from\s*["']\.\.?\//m);
});

test('the surface, choice and tab looks inline with the demos that use them', () => {
  const source = 'import { CheckboxMark, listRow, sectionSurface, tabsLook } from "./palette";\nmount(() => null);';
  const inlined = inlineGalleryUi(source, realSources);
  // look/choice.tsx, look/surface.tsx and look/tabs.tsx: modules with JSX of their own.
  expect(inlined).toContain('const MARK_WEIGHT = 3.2;');
  expect(inlined).toContain('const ROW_BLEED =');
  expect(inlined).toMatch(/tabsLook: __nshGalleryModule\d+\.tabsLook/);
  expect(inlined).not.toMatch(/^import\s.*from\s*["']\.\.?\//m);
});

test('the field and listbox looks inline with the demos that use them', () => {
  const source = 'import { datePickerLook, field, otpCellLook, Picker } from "./palette";\nmount(() => null);';
  const inlined = inlineGalleryUi(source, realSources);
  // look/field.tsx and look/listbox.tsx: JSX of their own; `nsh/base`'s types are only types.
  expect(inlined).toContain('const STEP_GLYPHS =');
  expect(inlined).toContain('const WEEKDAYS =');
  expect(inlined).toMatch(/Picker: __nshGalleryModule\d+\.Picker/);
  expect(inlined).not.toMatch(/^import\s.*from\s*["']\.\.?\//m);
});

test('the control families\' looks in look/ inline, their .tsx parts included', () => {
  const source =
    'import { progressLook, DisclosureChevron, LinkText, paginationItemClass, plotGrid, DockTab, richEditorClasses, photoUrl, scrollbarTheme } from "./palette";\nmount(() => null);';
  const inlined = inlineGalleryUi(source, realSources);
  expect(inlined).not.toMatch(/^import\s.*from\s*["'](?:\.\/|\.\.\/).*["']/m);
  for (const name of ['progressLook', 'DisclosureChevron', 'LinkText', 'paginationItemClass', 'plotGrid', 'DockTab', 'richEditorClasses', 'photoUrl', 'scrollbarTheme']) {
    expect(inlined).toMatch(new RegExp(`${name}: __nshGalleryModule\\d+\\.${name}`));
  }
  // Each family is its own scope: their private helpers do not collide.
  expect(inlined).toContain('const slide =');
  expect(inlined).toContain('const pageItem =');
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
