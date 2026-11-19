import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The shared looks and the demos' adapters take every color from the theme
// (`colors`, `tints`, `finish`, `token(..)`), so both apps follow its light
// and dark appearances and a theme change reaches every demo. A color
// written out, or a token's value spliced into a class string (read once,
// when the class is built), would not.

const root = join(import.meta.dir, '../..');

/** What the guard reads: files, or directories read with what they hold. */
const scanned = [
  'examples/nsh-gallery-ui/demo.ts',
  'examples/nsh-gallery-ui/palette.ts',
  'examples/nsh-gallery-ui/look',
  // Every website demo: the interface on the theme, content allowed below.
  'website/demos',
];

/** Files the guard skips, each with why its colors are content rather than
 * the interface's look (a canvas's drawing, a shader, a color picker's
 * swatches). */
const allowed: Record<string, string> = {
  'website/demos/el-avatar.tsx': "the initials' identity color, a hue per person's name (`avatarIdentity`), not the interface's",
  'website/demos/el-carousel.tsx': "white captions over the slides' photographs and the scrim under them",
  'website/demos/el-color-picker.tsx': 'the swatches and colors picked, the content of a color picker',
  'website/demos/el-image.tsx': "an SVG picture's drawing, the image shown",
  'website/demos/el-shader.tsx': "the shader's palettes and the white text over what it draws",
  'website/demos/el-text.tsx': 'the text styles shown: a highlight and a text shadow',
  'website/demos/el-video.tsx': "a video's black letterbox",
  'website/demos/guide-scrolling.tsx': "the tiles' own hues, the content scrolled",
  'website/demos/guide-styling.tsx': 'the gradients the styling guide shows',
  'website/demos/guide-tailwind.tsx': "Tailwind's own palette, arbitrary values and dark: variants, what the Tailwind guide shows",
  'website/demos/home-chat.tsx': "the home page's chat, drawn in that showcase's own system palette",
};

/** Color literals and spliced token values, by what each is. */
const rules: [string, RegExp][] = [
  ['a hex color', /#[0-9a-fA-F]{3,8}\b/],
  ['an rgb() / rgba() color', /\brgba?\(/],
  ['an hsl() / hsla() color', /\bhsla?\(/],
  ['a color-mix() (use the theme\'s alpha)', /\bcolor-mix\(/],
  ['an arbitrary color class', /\b(?:text|bg|border|fill|stroke|ring|outline|from|via|to)-\[#/],
  ['a value spliced into a class', /-\[\$\{/],
];

/** The sources under `path` (or `path` itself, a file): `.ts` and `.tsx`
 * files, not declarations, and nothing under a hidden directory (the
 * `.nsh/types` a type check writes beside an app). */
function files(path: string): string[] {
  const full = join(root, path);
  try {
    return readdirSync(full, { recursive: true, encoding: 'utf8' })
      // Not declarations, nor what the toolchain generates into dot directories (`.nsh/`, local, ignored by Git).
      .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts') && !name.split('/').some((part) => part.startsWith('.')))
      .map((name) => `${path}/${name}`);
  } catch {
    return [path];
  }
}

/** The source without its comments, which may cite an issue (`#1026`) or
 * name a color in prose. A `//` after a colon is a URL's, not a comment. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function violations(source: string): string[] {
  const found: string[] = [];
  code(source).split('\n').forEach((line, i) => {
    for (const [what, pattern] of rules) {
      if (pattern.test(line)) found.push(`${i + 1}: ${what}: ${line.trim()}`);
    }
  });
  return found;
}

test('the guard finds color literals and spliced values, not comments or tokens', () => {
  expect(violations('const a = "#c6ef6a";')).toHaveLength(1);
  expect(violations('borderColor: "rgba(0,0,0,0)",')).toHaveLength(1);
  expect(violations('color: "hsl(80 70% 60%)",')).toHaveLength(1);
  expect(violations('class: "text-[#fff] p-2",')).toHaveLength(2);
  expect(violations('class: `text-[${ui().text}]`,')).toHaveLength(1);
  expect(violations('// see #1026: rgba(0,0,0,0.4) once\nconst c = colors.text;')).toHaveLength(0);
  expect(violations('/* #ffffff */ const c = token("accent");')).toHaveLength(0);
  expect(violations('const url = "https://example.com/#top";')).toHaveLength(0);
});

test('the shared looks and the demo adapters take their colors from the theme', () => {
  const report: string[] = [];
  for (const file of scanned.flatMap(files)) {
    if (Object.hasOwn(allowed, file)) continue;
    for (const line of violations(readFileSync(join(root, file), 'utf8'))) report.push(`${file}:${line}`);
  }
  expect(report).toEqual([]);
});

test('every allowed file still exists and says why', () => {
  for (const [file, reason] of Object.entries(allowed)) {
    expect(readFileSync(join(root, file), 'utf8').length).toBeGreaterThan(0);
    expect(reason.length).toBeGreaterThan(0);
  }
});

// The demos' switches and toggles take the shared looks (`switchLook`,
// `toggleLook`): parts or an on state styled in place would be another copy
// of them, as the inline ones were (a switch's knob ran 2 points past the
// track with a pointer; light, a raised or sunk on state was all but the
// color of the surface under it).

/** Each opening tag of the element `name` in a source (`<Toggle ...>`, not
 * `<ToggleGroup ...>`): up to the `>` outside braces, past `//` comments. */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    let i = match.index + match[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i);
      else if (depth === 0 && c === '>') break;
    }
    tags.push(source.slice(match.index, i + 1));
  }
  return tags;
}

/** What is wrong with a switch's tag: styled parts, or no shared look. */
function switchViolations(tag: string): string[] {
  const found = [...tag.matchAll(/\b(track|thumb)(Class|Style)=/g)].map((m) => `sets ${m[1]}${m[2]}`);
  if (!/\{\.\.\.switchLook\(/.test(tag)) found.push('does not spread switchLook(..)');
  return found;
}

test('the switch guard finds styled parts and a missing look', () => {
  const styled = '<Switch checked={on()} trackClass="w-9" thumbStyle={{ x: 1 }}>\n  <Text>a</Text>\n</Switch>';
  expect(openingTags(styled, 'Switch')).toHaveLength(1);
  expect(switchViolations(openingTags(styled, 'Switch')[0])).toEqual(['sets trackClass', 'sets thumbStyle', 'does not spread switchLook(..)']);
  const shared = '<Switch\n  onChange={({ checked }) => on.set(checked)}\n  {...switchLook(() => on())}\n  // a note > here\n  hitSlop={0}\n>';
  expect(openingTags(shared, 'Switch')).toEqual([shared]);
  expect(switchViolations(shared)).toEqual([]);
});

test('the demos\' switches spread the shared look', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    for (const tag of openingTags(readFileSync(join(root, file), 'utf8'), 'Switch')) {
      for (const what of switchViolations(tag)) report.push(`${file}: ${what}: ${tag.split('\n')[0]}`);
    }
  }
  expect(report).toEqual([]);
});

/** What is wrong with a toggle's tag: no shared look. */
function toggleViolations(tag: string): string[] {
  return /\{\.\.\.toggleLook\(/.test(tag) ? [] : ['does not spread toggleLook(..)'];
}

test('the toggle guard finds a toggle without the shared look', () => {
  const styled = '<Toggle pressed={on()} pressedStyle={ui().raised} style={{ width: 28 }}>\n  <Text>B</Text>\n</Toggle>';
  expect(openingTags(styled, 'Toggle')).toHaveLength(1);
  expect(toggleViolations(openingTags(styled, 'Toggle')[0])).toEqual(['does not spread toggleLook(..)']);
  const shared = '<Toggle\n  pressed={on()}\n  onChange={({ pressed }) => on.set(pressed)}\n  // a note > here\n  {...toggleLook({ variant: "outline" })}\n>';
  expect(openingTags(shared, 'Toggle')).toEqual([shared]);
  expect(toggleViolations(shared)).toEqual([]);
  expect(openingTags('<ToggleGroup style={track}>', 'Toggle')).toEqual([]);
});

test('the demos\' toggles spread the shared look', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    for (const tag of openingTags(readFileSync(join(root, file), 'utf8'), 'Toggle')) {
      for (const what of toggleViolations(tag)) report.push(`${file}: ${what}: ${tag.split('\n')[0]}`);
    }
  }
  expect(report).toEqual([]);
});

// The demos' menus and overlays take the shared looks (`look/menu.tsx`,
// `look/overlay.ts`): a menu's rows highlighted in place lost the
// keyboard's highlight (no `focusStyle`), and the scrims, tooltips and
// surfaces styled in place each dimmed, inverted or floated differently.

/** What is wrong with a menu item's tag: no shared look. */
function menuItemViolations(tag: string): string[] {
  return /\{\.\.\.menuItemLook\(/.test(tag) ? [] : ['does not spread menuItemLook(..)'];
}

/** What is wrong with a modal's tag: a scrim of its own. */
function backdropViolations(tag: string): string[] {
  const style = /\bbackdropStyle=\{([^}]*\}?)\}/.exec(tag);
  if (/\bbackdropClass=/.test(tag)) return ['sets backdropClass'];
  return style && style[1].trim() !== 'backdrop()' ? [`sets backdropStyle={${style[1].trim()}}`] : [];
}

test('the overlay guards find a menu item without its look and a scrim of its own', () => {
  const own = '<MenuItem onSelect={go} hoverStyle={{ backgroundColor: tint(ui().accent, 0.08) }} style={row()}>';
  expect(menuItemViolations(openingTags(own, 'MenuItem')[0])).toEqual(['does not spread menuItemLook(..)']);
  const shared = '<MenuItem\n  onSelect={go}\n  // a note > here\n  {...menuItemLook()}\n>';
  expect(openingTags(shared, 'MenuItem')).toEqual([shared]);
  expect(menuItemViolations(shared)).toEqual([]);
  expect(openingTags('<MenuItems>', 'MenuItem')).toEqual([]);
  expect(backdropViolations('<Dialog open={a()} backdropStyle={{ backgroundColor: tint("#000000", 0.45) }} style={card}>')).toHaveLength(1);
  expect(backdropViolations('<Sheet backdropClass="bg-black/40">')).toEqual(['sets backdropClass']);
  expect(backdropViolations('<Menu popupStyle={popoverLook()} backdropStyle={backdrop()} trigger={t}>')).toEqual([]);
  expect(backdropViolations('<Menu {...menuPopup()} trigger={t}>')).toEqual([]);
  expect(backdropViolations('<Popover trigger={t}>')).toEqual([]);
});

test('the demos\' menus and overlays spread the shared looks', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const tag of openingTags(source, 'MenuItem')) {
      for (const what of menuItemViolations(tag)) report.push(`${file}: ${what}: ${tag.split('\n')[0]}`);
    }
    for (const name of ['Dialog', 'Sheet', 'Menu', 'ContextMenu']) {
      for (const tag of openingTags(source, name)) {
        for (const what of backdropViolations(tag)) report.push(`${file}: <${name}> ${what}`);
      }
    }
    // A tooltip's bubble, a popover's surface and a toast are the shared ones.
    if (/<Tooltip\b/.test(source) && !/\btooltipLook\(/.test(source)) report.push(`${file}: a Tooltip without tooltipLook(..)`);
    if (/<PopIn\b/.test(source) && !/\bpopoverLook\(/.test(source)) report.push(`${file}: a PopIn without popoverLook(..)`);
    for (const tag of openingTags(source, 'Toast')) {
      if (!/\bstyle=\{toastLook\(\)\}/.test(tag)) report.push(`${file}: a Toast without style={toastLook()}`);
    }
  }
  expect(report).toEqual([]);
});

// The demos' cards, checkboxes and tabs take the shared looks too: a card is
// `sectionSurface()` (flat, its corners the density's), a checkbox spreads
// `checkboxLook()` and a strip of tabs is laid out by one of the tab looks.
// A card with corners of its own, or a box drawn in place, drifted from the
// gallery's as the copies did (radii from 10 to 16 on one page, a check
// box's off state lighter than the field it stood for).

/** Whether a source has a card with corners of its own: an object (one
 * level of braces) that spreads `ui().card` and sets `borderRadius`, before
 * the spread (which overrides it) or after it. */
function ownCardCorners(source: string): boolean {
  return [...code(source).matchAll(/\{[^{}]*\.\.\.ui\(\)\.card\b[^{}]*\}/g)].some((m) => /\bborderRadius:/.test(m[0]));
}

test('the card guard finds a card with corners of its own', () => {
  expect(ownCardCorners('<View style={{ ...ui().card, borderRadius: 14, padding: 16 }}>')).toBe(true);
  expect(ownCardCorners('<View style={{ borderRadius: 14, padding: 16, ...ui().card }}>')).toBe(true);
  expect(ownCardCorners('<View style={{ ...ui().card, flex: 1, borderRadius: 12, overflow: "hidden" }}>')).toBe(true);
  expect(ownCardCorners('<View style={{ ...sectionSurface(), padding: 16 }}>')).toBe(false);
  expect(ownCardCorners('<Dot style={{ borderRadius: 4, backgroundColor: ui().card.backgroundColor }} />')).toBe(false);
});

test('the demos\' cards are the shared section surface', () => {
  const report = files('website/demos')
    .filter((file) => ownCardCorners(readFileSync(join(root, file), 'utf8')))
    .map((file) => `${file}: spreads ui().card with a radius of its own (use sectionSurface())`);
  expect(report).toEqual([]);
});

/** What is wrong with a checkbox's tag: no shared look. */
function checkboxViolations(tag: string): string[] {
  return /\{\.\.\.checkboxLook\(/.test(tag) ? [] : ['does not spread checkboxLook(..)'];
}

test('the checkbox guard finds a checkbox without the shared look', () => {
  const styled = '<Checkbox checked={on()} indicatorStyle={{ width: 16 }}>';
  expect(checkboxViolations(openingTags(styled, 'Checkbox')[0])).toEqual(['does not spread checkboxLook(..)']);
  const shared = '<Checkbox\n  checked={on()}\n  {...checkboxLook()}\n  indicator={<CheckboxMark mark="check" />}\n>';
  expect(openingTags(shared, 'Checkbox')).toHaveLength(1);
  expect(checkboxViolations(openingTags(shared, 'Checkbox')[0])).toEqual([]);
});

test('the demos\' checkboxes spread the shared look', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    for (const tag of openingTags(readFileSync(join(root, file), 'utf8'), 'Checkbox')) {
      for (const what of checkboxViolations(tag)) report.push(`${file}: ${what}: ${tag.split('\n')[0]}`);
    }
  }
  expect(report).toEqual([]);
});

test('the demos\' tabs are laid out by a shared tab look', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    const source = readFileSync(join(root, file), 'utf8');
    if (openingTags(source, 'Tabs').length === 0) continue;
    if (!/\b(?:tabsLook|underlineTabsLook|segmentedLook)\(/.test(source)) report.push(`${file}: <Tabs> without tabsLook(), underlineTabsLook() or segmentedLook()`);
  }
  expect(report).toEqual([]);
});

// The demos' form controls take the shared looks too: an input spreads the
// field look (`field()`, `inputLook()`), a select's and a combobox's list
// spread `listboxProps()`, a combobox its field (`comboboxLook()`), a date
// picker `datePickerLook()`, a number input's well is `numberInputClasses`'
// and a one-time code's cells `otpCellLook()`'s. Their copies had drifted:
// three focus looks, a trigger whose open and error edges a finish hid, a
// list's colors spliced into a class once.

/** The looks each control's opening tag must use, by element name. */
const formLooks: [string, RegExp, string][] = [
  ['Input', /\{\.\.\.(?:field|inputLook)\(/, 'does not spread field(..) or inputLook(..)'],
  ['ColorField', /\{\.\.\.(?:field|inputLook)\(/, 'does not spread field(..) or inputLook(..)'],
  ['Select', /\{\.\.\.listboxProps\(/, 'does not spread listboxProps(..)'],
  ['Combobox', /\{\.\.\.listboxProps\(/, 'does not spread listboxProps(..)'],
  ['Combobox', /\{\.\.\.comboboxLook\(/, 'does not spread comboboxLook(..)'],
  ['DatePicker', /\{\.\.\.datePickerLook\(/, 'does not spread datePickerLook(..)'],
  ['NumberInput', /\bclass=\{numberInputClasses\.frame\}/, 'is not numberInputClasses.frame'],
  ['OtpInput', /\{\.\.\.otpCellLook\(/, 'does not spread otpCellLook(..)'],
];

/** Demos whose inputs are content, each with why. */
const ownInputs: Record<string, string> = {
  'website/demos/home-chat.tsx': "the home page's chat composer, drawn in that showcase's own system palette",
};

test('the form guard finds a control without its shared look', () => {
  const own = '<Select items={items} popupStyle={{ ...ui().card, borderRadius: 12 }} itemClass="rounded-lg">';
  const select = formLooks.filter(([name]) => name === 'Select');
  expect(select.flatMap(([, pattern, what]) => (pattern.test(own) ? [] : [what]))).toEqual(['does not spread listboxProps(..)']);
  const shared = '<Combobox\n  items={items}\n  {...comboboxLook(() => open())}\n  {...listboxProps()}\n>';
  const combobox = formLooks.filter(([name]) => name === 'Combobox');
  expect(openingTags(shared, 'Combobox')).toEqual([shared]);
  expect(combobox.flatMap(([, pattern, what]) => (pattern.test(shared) ? [] : [what]))).toEqual([]);
});

test('the demos\' form controls take the shared looks', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    if (Object.hasOwn(ownInputs, file)) continue;
    const source = readFileSync(join(root, file), 'utf8');
    for (const [name, pattern, what] of formLooks) {
      for (const tag of openingTags(source, name)) {
        if (!pattern.test(tag)) report.push(`${file}: <${name}> ${what}: ${tag.split('\n')[0]}`);
      }
    }
  }
  expect(report).toEqual([]);
});

/** The other controls' shared looks: what a website demo's tag of each
 * spreads (`needs`), and the parts it must not style in place instead
 * (`forbids`), so the demos keep the gallery's look. */
const looks: { tag: string; needs?: RegExp; forbids?: RegExp; look: string }[] = [
  { tag: 'Progress', needs: /\{\.\.\.progressLook\(/, forbids: /\b(?:track|indicator)(?:Class|Style)=/, look: 'progressLook(..)' },
  { tag: 'AccordionTrigger', needs: /\{\.\.\.disclosureTriggerLook\(/, look: 'disclosureTriggerLook(..)' },
  { tag: 'CarouselPaginationItem', needs: /\{\.\.\.carouselDotItemLook\(/, look: 'carouselDotItemLook()' },
  { tag: 'Link', needs: /\{\.\.\.linkLook\(/, look: 'linkLook(..)' },
  { tag: 'Pagination', forbids: /\bitemClass=["'`]/, look: 'paginationItemClass(..)' },
  { tag: 'Scrollbar', needs: /\bscrollbarTheme\.(?:vertical|horizontal)\b/, forbids: /\bthumbStyle=/, look: 'scrollbarTheme' },
  { tag: 'Plot', forbids: /\bcrossLine(?:Class|Style)=/, look: 'plotCrossLine(..)' },
  { tag: 'ResizablePanelGroup', needs: /\{\.\.\.resizableHandleLook\(/, forbids: /\bhandle(?:Thumb)?Class=/, look: 'resizableHandleLook(..)' },
  { tag: 'DockArea', needs: /\{\.\.\.dockClasses\}/, look: 'dockClasses' },
  { tag: 'RichEditor', needs: /\bclasses=\{richEditorClasses\}/, look: 'richEditorClasses' },
];

/** What is wrong with a tag of `rule`'s element: a part styled in place, or no shared look. */
function lookViolations(rule: (typeof looks)[number], tag: string): string[] {
  const found: string[] = [];
  if (rule.forbids?.test(tag)) found.push(`styles in place what ${rule.look} owns`);
  if (rule.needs && !rule.needs.test(tag)) found.push(`does not use ${rule.look}`);
  return found;
}

test('the look guard finds styled parts and a missing look', () => {
  const [progress, plot] = looks.filter((r) => r.tag === 'Progress' || r.tag === 'Plot');
  const styled = '<Progress value={v()} indicatorStyle={{ backgroundColor: x }}>';
  expect(lookViolations(progress, styled)).toEqual(['styles in place what progressLook(..) owns', 'does not use progressLook(..)']);
  expect(lookViolations(progress, '<Progress value={v()} {...progressLook(() => v())}>')).toEqual([]);
  expect(lookViolations(plot, '<Plot data={d} crossLineClass="w-px">')).toEqual(['styles in place what plotCrossLine(..) owns']);
  expect(lookViolations(plot, '<Plot data={d} {...plotCrossLine()}>')).toEqual([]);
});

test('the demos\' other controls take the shared looks', () => {
  const report: string[] = [];
  for (const file of files('website/demos')) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const rule of looks) {
      for (const tag of openingTags(source, rule.tag)) {
        for (const what of lookViolations(rule, tag)) report.push(`${file}: ${what}: ${tag.split('\n')[0]}`);
      }
    }
  }
  expect(report).toEqual([]);
});

test('every demo with inputs of its own still exists and says why', () => {
  for (const [file, reason] of Object.entries(ownInputs)) {
    expect(readFileSync(join(root, file), 'utf8')).toContain('<Input');
    expect(reason.length).toBeGreaterThan(0);
  }
});
