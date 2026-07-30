// Computed-style contract for the Astryx renderer migration (#1565, PR 0).
//
//   node scripts/check-visual-contract.mjs                  # compare main → working tree
//   node scripts/check-visual-contract.mjs --against <ref>  # a different base
//   node scripts/check-visual-contract.mjs --route chat --theme dark --platform win32
//
// One command captures BOTH sides and diffs them in memory: the base ref is
// checked out into a cached temporary worktree with its own `npm ci` (see
// ensureBaseBuild — a slice may legitimately change dependencies), both sides
// are built, and every route × theme × platform is captured from each build.
// There is no baseline file. An earlier version had one, captured by hand on
// the base branch and compared by hand after switching: every step a human
// could skip (rebuild after switching, recapture after rebasing) produced a
// convincing zero-diff pass that had measured the same binary twice. A
// measurement instrument must not be able to confuse "no change" with "not
// measured", so the instrument owns the whole measurement now.
//
// Both sides come from the same host in the same run, which is what makes the
// captures comparable at all — font metrics and the macOS traffic-light inset
// are host facts, encoded in every capture.
//
// The win32 column runs on any darwin/linux host: MAKA_E2E_FIXTURE_PLATFORM
// drives the production `app:info → data-os` path, which is what keys the
// per-OS CSS. It covers the cascade, not native chrome. (A Windows *host* is
// not supported — the dev fleet is darwin/linux and the plain `spawn('npm')`
// calls would need `.cmd` resolution there.)
//
// This gates NO-CHANGE, not correctness. A pre-existing visual bug on the
// base is out of scope for the migration: "zero diff" means "the migration
// did not move this element", never "this element is right".
//
// Known blind spots, stated rather than papered over:
//   - Elements inside a `display: none` subtree have no box and never enter
//     the capture, so closed menus, popovers and unmounted dialogs are out of
//     contract. Covering them means driving the UI open, which is an
//     interaction test, not a snapshot.
//   - Pseudo-elements are captured as paint signatures only: they expose no
//     client rect, so a pseudo that moves without changing any computed
//     property is invisible here.
//   - Top-layer content (dialog.showModal, popover, fullscreen) renders even
//     under an opacity:0 ancestor, but the walk prunes that subtree. Nothing
//     in the app uses the native top layer today; if that changes, the prune
//     needs a top-layer exemption.
//   - Animations and transitions are disabled for the duration of the
//     capture: a running spinner's transform is a read of the clock, not of
//     the cascade, and two captures at arbitrary phases would diff forever.
//     The cost is that motion itself is out of contract: a migration that
//     drops an `animation` rule is invisible here, because both sides are
//     captured with animations off.
//
// Migration-only scaffolding. It is deliberately not wired into CI, following
// the check:chat-visual precedent, and is removed in PR 14 together with the
// maka.legacy layer.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withFixtureWindow } from './fixture-window.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The five representative routes from #1565. The issue names product routes;
// these are the MAKA_E2E_FIXTURE scenarios that actually open them on main —
// there is no scenario literally named "settings-providers" or "chat".
// `ready` is the element that means "this surface has rendered". Without it
// the only alternative is a fixed sleep, which captures a half-mounted route
// as a clean one on a slow machine — and writes that into the baseline.
const ROUTES = [
  // Chat session with the task workbar open.
  { id: 'chat', scenario: 'turn-narrative', ready: '.maka-session-workbar' },
  { id: 'settings-general', scenario: 'settings-general', ready: '.settingsRows' },
  // Providers live under the 模型 settings section.
  { id: 'settings-providers', scenario: 'provider-workspace', ready: '.providersPanel' },
  { id: 'mcp-hub', scenario: 'module-mcp', ready: '.maka-module-main-header' },
  // Empty profile, first launch.
  { id: 'onboarding', scenario: 'first-run', ready: '.maka-onboarding-surface' },
];
const THEMES = ['light', 'dark'];
// #1565 asks for darwin AND win32: the per-OS CSS is keyed off
// `html[data-os]`, so a regression under the win32 cascade is invisible in a
// darwin-only capture for the whole migration. The fixture platform override
// flips `data-os` through the production path on any host.
const PLATFORMS = ['darwin', 'win32'];

// #1565 mandates the alignment properties (alignItems/justifyContent/gap/
// gridArea) alongside the usual box and paint set: flex and grid misalignment
// is the regression class a style-only property set cannot see. `placeItems`
// is deliberately absent — it is the shorthand of `alignItems`/`justifyItems`,
// and across a full capture its first token equalled `alignItems` on every
// single record, so it carried no independent signal.
//
// The paint properties past the box set exist because a cascade-layer flip is
// exactly the change that alters them without moving anything: a utility that
// now beats a product rule can change elevation (boxShadow), text placement
// inside an unchanged box (textAlign), or the axis a row lays out on
// (flexDirection/flexWrap) with an identical rect.
//
// Shorthands are recorded where Chromium resolves them, which keeps the
// capture a third of the size of its longhand equivalent. Computed
// width/height are omitted because the recorded rect already carries the
// used box, and it also reflects transforms and flex stretching.
export const PROPERTIES = [
  'display',
  'position',
  'inset',
  'zIndex',
  'opacity',
  'pointerEvents',
  'cursor',
  'overflow',
  'padding',
  'margin',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'outline',
  'mixBlendMode',
  // The paint-only channels: none of these move the rect, so losing one is
  // invisible to every other property here. All four are live in this
  // renderer — grayscale() on disabled provider rows, backdrop blur on the
  // glass theme, clip-path as visually-hidden, rotate() on chevrons (a
  // square rotated 90° has an identical bounding box).
  'filter',
  'backdropFilter',
  'clipPath',
  'transform',
  'transformOrigin',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'textAlign',
  'backgroundColor',
  'backgroundImage',
  'alignItems',
  'justifyContent',
  'flexDirection',
  'flexWrap',
  'gap',
  'gridArea',
];

// Two kinds of noise are dropped rather than recorded. A property equal to
// its initial value says nothing (most of the tree carries `zIndex: auto`,
// `backgroundImage: none`), and an inherited property equal to the parent's
// says only that inheritance works. Both are restored on read as "absent
// means unchanged", so a migration that starts setting one shows up as a
// diff from ∅. Without this the baselines are three times the size and the
// signal is buried.
//
// Every value here is what Chromium actually serialises, verified against a
// real capture — the previous table guessed at three of them (`normal normal`,
// `auto / auto / auto / auto`) and those entries never matched once, so the
// properties they were meant to suppress appeared on all 3,964 records.
// `findDeadOmissionRules` below fails the run if that regresses.
export const INITIAL_VALUES = {
  position: 'static',
  inset: 'auto',
  zIndex: 'auto',
  opacity: '1',
  overflow: 'visible',
  padding: '0px',
  margin: '0px',
  borderWidth: '0px',
  borderStyle: 'none',
  borderRadius: '0px',
  boxShadow: 'none',
  mixBlendMode: 'normal',
  filter: 'none',
  backdropFilter: 'none',
  clipPath: 'none',
  transform: 'none',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  alignItems: 'normal',
  justifyContent: 'normal',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  gap: 'normal',
  gridArea: 'auto',
};
// Every property here that CSS inherits, and none that it does not. A CSS-
// inherited property in PROPERTIES but missing from this list is the bug
// class that shipped twice: each descendant re-records the ancestor's value,
// so one container change prints as N descendant lines and eats the print
// limit. An inherited property must not also appear in INITIAL_VALUES —
// "absent" has to mean exactly one thing (equal to the nearest recorded
// ancestor), or a reader cannot recover the value. Both rules are pinned by
// check-visual-contract.test.mjs.
export const INHERITED_PROPERTIES = [
  'cursor',
  'pointerEvents',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'textAlign',
];

const CAPTURE_EXPR = `(() => {
  const PROPERTIES = ${JSON.stringify(PROPERTIES)};
  const INITIAL_VALUES = ${JSON.stringify(INITIAL_VALUES)};
  const INHERITED = new Set(${JSON.stringify(INHERITED_PROPERTIES)});
  // Stop the clock before reading a single style. transform is sampled, and a
  // running spinner serialises a different matrix at every phase — the two
  // sides are captured seconds apart, so animated values would diff on time,
  // not on the cascade. Both sides get the identical freeze; see the header's
  // blind-spot note for what that trades away.
  if (!document.getElementById('maka-visual-contract-freeze')) {
    const freeze = document.createElement('style');
    freeze.id = 'maka-visual-contract-freeze';
    freeze.textContent =
      '*, *::before, *::after { animation: none !important; transition: none !important; }';
    document.head.append(freeze);
  }
  // Round to 0.5px. Sub-pixel layout differs run to run on the same build
  // (fractional scroll offsets, font metrics), and that jitter is not a
  // migration signal.
  const half = (n) => Math.round(n * 2) / 2;
  const roundPx = (value) =>
    typeof value === 'string'
      ? value.replace(/-?\\d+\\.\\d+px/g, (m) => half(Number.parseFloat(m)) + 'px')
      : value;
  const label = (el) => {
    // Deliberately not el.id: Base UI mints ids through useId, so they change
    // on every render and would make every capture differ from the last.
    const explicit = el.getAttribute('data-testid') || el.getAttribute('aria-label') || '';
    if (explicit) return explicit.slice(0, 40);
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    return own.slice(0, 40);
  };
  // OverlayScrollbars' own chrome fades in and out with pointer activity, so
  // whether a scrollbar is "visible" at capture time is a coin flip rather
  // than a migration signal — it made onboarding differ from itself run to
  // run. The tracks carry no product layout, so the subtree is skipped
  // whole.
  const DECORATION = '.os-scrollbar, .os-trinsic-observer';
  const out = [];
  // Dead-rule accounting happens HERE, at the raw sample, not by inspecting
  // the compressed output afterwards: a rule can be shadowed by another skip
  // (the border/outline paint gates) and an output-based check would never
  // know whether it matched. A rule with zero hits across every sampled
  // element never matches what Chromium serialises.
  const hits = {};
  for (const property of Object.keys(INITIAL_VALUES)) hits[property] = 0;
  let sampled = 0;
  const writeStyles = (style, record, inheritedBase) => {
    sampled += 1;
    const paintsBorder = Number.parseFloat(style.borderWidth) > 0;
    // Outline's shorthand resolves its colour from currentColor, so an
    // unpainted outline still serialises a per-element value that can never
    // equal a fixed initial. Style is what decides whether it paints.
    const paintsOutline = style.outlineStyle !== 'none';
    for (const property of PROPERTIES) {
      const value = roundPx(style[property]);
      if (value === '' || value == null) continue;
      if (INITIAL_VALUES[property] === value) {
        hits[property] += 1;
        continue;
      }
      // Tailwind's preflight sets border-style:solid on every element, so a
      // zero-width border carries a style and a colour that paint nothing.
      if (!paintsBorder && (property === 'borderStyle' || property === 'borderColor')) continue;
      if (!paintsOutline && property === 'outline') continue;
      // transform-origin computes to a concrete px pair on every element (it
      // depends on the box, so it has no fixed initial to omit against), and
      // it paints nothing until a transform exists.
      if (property === 'transformOrigin' && style.transform === 'none') continue;
      if (INHERITED.has(property) && inheritedBase[property] === value) continue;
      record[property] = value;
    }
  };
  // The 'inherited' argument is the inherited state of the nearest RECORDED
  // ancestor, not of the parent element. Those differ whenever a wrapper has
  // no box — a zero-size or display:contents node is skipped, so nothing in
  // the capture carries its values. Comparing against the parent there let a
  // visible child omit a property because it matched an ancestor the reader
  // cannot see: flip that wrapper's color and the child really repaints while
  // the capture stays byte-identical. Comparing against the nearest recorded
  // ancestor keeps every omission recoverable by a reader of the file.
  const walk = (el, path, inherited) => {
    if (el.matches(DECORATION)) return;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // Opacity multiplies down the tree and is not inherited: every descendant
    // of an opacity:0 element reports its own opacity as 1 and a non-zero
    // rect, yet nothing beneath can paint. Without this prune the collapsed
    // session panel put 105 invisible records into the chat capture, and a
    // style change inside it would read as a visual diff on pixels that never
    // change. visibility:hidden does NOT prune — a descendant can restore
    // visibility:visible and genuinely paint.
    if (Number.parseFloat(style.opacity) === 0) return;
    const ownInherited = {};
    for (const property of INHERITED) ownInherited[property] = roundPx(style[property]);
    // Only elements a reviewer could see. An invisible element that stays
    // invisible is not a visual contract, and skipping them keeps the
    // baselines to the part of the tree the migration can actually move.
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';
    if (visible) {
      const record = {
        path,
        rect: [half(rect.x), half(rect.y), half(rect.width), half(rect.height)],
      };
      const text = label(el);
      if (text) record.label = text;
      const role = el.getAttribute('role');
      if (role) record.role = role;
      // Enough of the class list to recognise the component in a diff, and no
      // more. Utility classes are omitted: there are hundreds of them, they
      // are the first thing a migration rewrites, and a path plus a product
      // class already says which element this is. The filter keeps names that
      // are namespaced or camelCased — how this codebase writes its own
      // classes — and drops the all-lowercase utility vocabulary.
      const named = [...el.classList]
        .filter((name) => name.startsWith('maka-') || /[A-Z]/.test(name))
        .slice(0, 3);
      if (named.length > 0) record.classes = named.join(' ');
      writeStyles(style, record, inherited);
      out.push(record);
      // Painted pseudo-elements. A cascade migration can flip a decoration
      // like the body::after film-grain overlay — opacity, blend mode,
      // background — while the host element's own record stays byte-identical.
      // Pseudo-elements have no client rect to read, so this is a paint
      // signature only; they inherit from their originating element.
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.display === 'none') continue;
        if (ps.visibility === 'hidden' || Number.parseFloat(ps.opacity) === 0) continue;
        const pseudoRecord = { path: path + pseudo };
        if (ps.content !== '""') pseudoRecord.content = ps.content.slice(0, 40);
        writeStyles(ps, pseudoRecord, ownInherited);
        out.push(pseudoRecord);
      }
    }
    // Descend even through invisible parents: a zero-size wrapper can still
    // hold visible children (common for absolutely positioned overlays). Only
    // a recorded element updates the inherited baseline (see walk above).
    const nextInherited = visible ? ownInherited : inherited;
    const children = el.children;
    const counts = new Map();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      const index = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, index);
      walk(child, path + '>' + tag + (index > 1 ? ':' + index : ''), nextInherited);
    }
  };
  walk(document.body, 'body', {});
  return JSON.stringify({ records: out, omission: { sampled, hits } });
})()`;

// #1565 asks for the mega-branch's late "fix cascade / fix click" commits to
// be transcribed into assertions. Reading them, six of the eight land on
// properties this snapshot already records — a wrapped titlebar row, a
// timestamp stacking above its title, a missing gap, a column painting over
// the settings rail all move a rect or one of the recorded properties, so a
// diff catches them without a bespoke rule. What a bespoke rule does add is
// noticing when the harness stops watching: if a migration removes the class
// these regressions happened on, the element silently leaves the baseline and
// the diff goes quiet. So each salvaged regression is pinned to an anchor
// that must keep appearing.
//
// Two of the eight are not transcribable: 3e57d1951 (stat tile leading) and
// 400e8f4a9 (turn marker measure) fix files the mega-branch itself created,
// which do not exist on main. They are recorded in the PR body as fragile
// spots for the slice that introduces those components, not asserted here.
//
// One is only partly covered: fd38a37ce (composer frame jumping on focus) is
// a focus-state regression, and this harness captures the resting state.
const SALVAGED_ANCHORS = [
  {
    commit: 'be5e69584',
    regression: 'titlebar clusters wrapped onto a second row',
    route: 'chat',
    anchor: 'maka-shell-topbar-rail',
  },
  {
    commit: 'fd38a37ce',
    regression: 'composer frame jumped when focused (resting state only)',
    route: 'chat',
    anchor: 'maka-composer-inner',
  },
  // Route mcp-hub, not chat: the chat fixture keeps the session panel
  // collapsed, where these rows sit under an opacity:0 ancestor. Before the
  // capture pruned invisible subtrees, the anchors "matched" phantom records
  // there — presence without a single visible pixel. The mcp-hub fixture
  // opens the sidebar, so the rows it watches actually paint.
  {
    commit: '9aad59740',
    regression: 'every session timestamp stacked above its title',
    route: 'mcp-hub',
    anchor: 'maka-list-row-meta',
  },
  {
    commit: '3dbd68ca7',
    regression: 'sidebar nav rows had two competing styling authorities',
    route: 'mcp-hub',
    anchor: 'maka-list-row',
  },
  {
    commit: '9d20a9396',
    regression: "task ledger's recent-count collided with its label",
    route: 'chat',
    anchor: 'maka-session-workbar-count',
  },
  {
    commit: 'be1406705',
    regression: 'settings content column painted over the nav rail',
    route: 'settings-general',
    anchor: 'settingsSidebar',
  },
];

// Exact class-token match, not substring: `maka-list-row` as a substring is
// satisfied by `maka-list-row-meta`, so a loose check would report an anchor
// as watched by an element that is not the one the regression happened on.
export function checkSalvagedAnchors(captures, anchors = SALVAGED_ANCHORS) {
  const missing = [];
  for (const entry of anchors) {
    const records = captures.get(`${entry.route}.light.darwin`);
    if (!records) continue;
    const present = records.some((record) =>
      (record.classes ?? '').split(' ').includes(entry.anchor),
    );
    if (!present) missing.push(entry);
  }
  return missing;
}

/**
 * Fail loudly when an omission rule never matches what Chromium serialises.
 * The previous table guessed three values, none of them ever matched, and the
 * properties they were meant to drop ended up on every record — invisible,
 * because over-recording never fails anything.
 *
 * Judged from the raw sampling counts the capture takes as it reads each
 * computed value, not from the compressed output: a rule shadowed by another
 * skip (the border/outline paint gates) is invisible in the output but still
 * counted at the sample.
 */
export function findDeadOmissionRules(omission, initialValues = INITIAL_VALUES) {
  if (!omission || omission.sampled === 0) return [];
  const dead = [];
  for (const property of Object.keys(initialValues)) {
    if ((omission.hits[property] ?? 0) === 0) dead.push({ property, sampled: omission.sampled });
  }
  return dead;
}

export function parseArgs(argv) {
  const args = { against: 'main', routes: null, themes: null, platforms: null, help: false };
  const value = (index, flag) => {
    const next = argv[index];
    if (next === undefined || next.startsWith('--')) {
      console.error(`[visual-contract] ${flag} needs a value`);
      process.exit(2);
    }
    return next;
  };
  // Closed sets. An unknown value must not reach the capture: the fixture
  // fails closed on an invalid platform (the app reports the real host OS),
  // so `--platform not-an-os` would print a green comparison labelled with a
  // platform it never measured.
  const oneOf = (index, flag, allowed) => {
    const next = value(index, flag);
    if (!allowed.includes(next)) {
      console.error(`[visual-contract] ${flag} must be one of: ${allowed.join(', ')}`);
      process.exit(2);
    }
    return next;
  };
  const routeIds = ROUTES.map((route) => route.id);
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--against') args.against = value(++i, arg);
    else if (arg === '--route') (args.routes ??= []).push(oneOf(++i, arg, routeIds));
    else if (arg === '--theme') (args.themes ??= []).push(oneOf(++i, arg, THEMES));
    else if (arg === '--platform') (args.platforms ??= []).push(oneOf(++i, arg, PLATFORMS));
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`[visual-contract] unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

/** Run a command to completion, returning stdout; throw with stderr on failure. */
function run(command, argv, cwd, { inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`${command} ${argv.join(' ')} exited ${code}${stderr ? `\n${stderr}` : ''}`),
        );
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the desktop app plus its workspace dependencies inside `dir`.
 * `build:with-deps` names that chain, but a base ref can predate the script,
 * so fall back to the same chain its `e2e` script has always inlined.
 */
async function buildDesktop(dir) {
  const pkg = JSON.parse(await readFile(join(dir, 'apps', 'desktop', 'package.json'), 'utf8'));
  if (pkg.scripts?.['build:with-deps']) {
    await run('npm', ['--workspace', '@maka/desktop', 'run', 'build:with-deps'], dir, {
      inherit: true,
    });
    return;
  }
  for (const workspace of [
    '@maka/core',
    '@maka/storage',
    '@maka/mcp',
    '@maka/runtime',
    '@maka/computer-use',
    '@maka/ui',
    '@maka/desktop',
  ]) {
    await run('npm', ['--workspace', workspace, 'run', 'build'], dir, { inherit: true });
  }
}

/**
 * A worktree of `ref` with its own `npm ci` and a finished build, cached in
 * tmpdir keyed by the resolved commit — iterating on a slice rebuilds only
 * the working tree, not the base. The cache is sound because the key is the
 * content: a different base commit is a different directory. Stale worktree
 * registrations are pruned on the next run after the OS clears its tmpdir.
 *
 * The install is deliberately NOT shared with this checkout. An earlier
 * version symlinked node_modules across, and the workspace links inside it
 * (`node_modules/@maka/* → ../../packages/*`) resolved right back to the
 * WORKING TREE's packages — the base bundled and loaded the candidate's own
 * code, so a slice that changed a workspace package compared it against
 * itself. `npm ci` against the base's own lockfile is the only dependency
 * closure that actually belongs to the base; it also means a slice may
 * legitimately change dependencies. Cost: one install per new base commit,
 * then cached.
 */
async function ensureBaseBuild(ref) {
  const sha = (await run('git', ['rev-parse', `${ref}^{commit}`], ROOT)).trim();
  const dir = join(tmpdir(), `maka-visual-contract-${sha.slice(0, 12)}`);
  // The marker name encodes the install scheme: caches built by the earlier
  // symlink-sharing version carry a different marker and are rebuilt, not
  // trusted — their dependency closure was the working tree's, not the base's.
  const marker = join(dir, '.maka-visual-contract-ci-built');
  if (await exists(marker)) {
    console.log(`base ${ref} (${sha.slice(0, 12)}): reusing cached build in ${dir}`);
    return { dir, sha };
  }
  // Two concurrent runs must not build into the same directory — the loser
  // would rm the winner's half-finished build. mkdir is atomic; the loser
  // fails loudly rather than corrupting the cache.
  const lockDir = `${dir}.lock`;
  try {
    await mkdir(lockDir);
  } catch {
    throw new Error(
      `another compare is already building this base (${lockDir} exists). Wait for it, or remove the lock if that run is dead.`,
    );
  }
  try {
    if (await exists(marker)) {
      console.log(`base ${ref} (${sha.slice(0, 12)}): reusing cached build in ${dir}`);
      return { dir, sha };
    }
    console.log(`base ${ref} (${sha.slice(0, 12)}): worktree + npm ci + build in ${dir}`);
    await rm(dir, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], ROOT);
    await run('git', ['worktree', 'add', '--detach', dir, sha], ROOT);
    await run('npm', ['ci'], dir, { inherit: true });
    await buildDesktop(dir);
    await writeFile(marker, sha);
    return { dir, sha };
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// Report every element that appeared, disappeared, or changed any recorded
// property — with the property names, so a reviewer can tell "this moved 4px"
// from "this lost its background".
//
// Identity is the element's position in the tree, which holds exactly as long
// as the tree does. That is the right trade for the slice this harness was
// built for — PR 1 normalises the cascade without touching a single element —
// but it does not survive a structural edit: inserting one wrapper renames
// every path beneath it, and each renamed record reads as a `removed` plus an
// `added`. `summarise` below names that case instead of letting a reviewer
// read hundreds of truncated lines as hundreds of regressions.
export function diffRecords(baseline, current) {
  const byPath = (records) => new Map(records.map((record) => [record.path, record]));
  const before = byPath(baseline);
  const after = byPath(current);
  const changes = [];
  for (const [path, record] of before) {
    const next = after.get(path);
    if (!next) {
      changes.push({ kind: 'removed', path, label: record.label });
      continue;
    }
    const properties = [];
    for (const key of new Set([...Object.keys(record), ...Object.keys(next)])) {
      if (key === 'path') continue;
      const a = JSON.stringify(record[key]);
      const b = JSON.stringify(next[key]);
      if (a !== b) properties.push({ property: key, before: record[key], after: next[key] });
    }
    if (properties.length > 0) {
      changes.push({ kind: 'changed', path, label: record.label ?? next.label, properties });
    }
  }
  for (const [path, record] of after) {
    if (!before.has(path)) changes.push({ kind: 'added', path, label: record.label });
  }
  // `changed` first: those are diffs on elements that still exist, which is
  // the signal. A structural edit produces a flood of removed/added that would
  // otherwise push every real property change past the print limit.
  const rank = { changed: 0, removed: 1, added: 2 };
  return changes.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Describe a diff in one line, and say so when its shape means the tree moved
 * rather than the styles.
 */
export function summarise(changes, baselineSize) {
  const counts = { changed: 0, removed: 0, added: 0 };
  for (const change of changes) counts[change.kind] += 1;
  const parts = [];
  for (const kind of ['changed', 'removed', 'added']) {
    if (counts[kind] > 0) parts.push(`${counts[kind]} ${kind}`);
  }
  // Losing most of the baseline to `removed` is what a wrapper insertion looks
  // like; it is not most of the UI disappearing.
  const structural = baselineSize > 0 && counts.removed > baselineSize / 2;
  return { text: parts.join(', '), structural };
}

function formatChange(change) {
  const name = change.label ? ` "${change.label}"` : '';
  if (change.kind !== 'changed') return `  ${change.kind.padEnd(7)} ${change.path}${name}`;
  const properties = change.properties
    .map(({ property, before, after }) => {
      const from = Array.isArray(before) ? before.join(',') : (before ?? '∅');
      const to = Array.isArray(after) ? after.join(',') : (after ?? '∅');
      return `${property}: ${from} → ${to}`;
    })
    .join('; ');
  return `  changed ${change.path}${name}\n            ${properties}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      `Usage: check-visual-contract.mjs [--against ref] [--route id]... [--theme light|dark]... [--platform darwin|win32]...\n\n` +
        `Builds the base ref (cached, temp worktree) and the working tree, captures\n` +
        `every route x theme x platform from both builds, and diffs them in memory.\n\n` +
        `Routes: ${ROUTES.map((route) => route.id).join(', ')}\n`,
    );
    return;
  }
  const routes = args.routes ? ROUTES.filter((route) => args.routes.includes(route.id)) : ROUTES;
  const themes = args.themes ?? THEMES;
  const platforms = args.platforms ?? PLATFORMS;
  const base = await ensureBaseBuild(args.against);
  console.log('building the working tree');
  await buildDesktop(ROOT);
  const baseDesktopDir = join(base.dir, 'apps', 'desktop');
  let failures = 0;
  let compared = 0;
  const captures = new Map();
  for (const route of routes) {
    for (const theme of themes) {
      for (const platform of platforms) {
        const key = `${route.id} ${theme} ${platform}`;
        const capture = (desktopDir) =>
          withFixtureWindow(
            route.scenario,
            { theme, platform, readySelector: route.ready, desktopDir },
            async ({ evaluate, page }) => {
              // The capture must prove it measured the cascade it claims.
              // data-os arrives async over app:info and fails silently unset;
              // if that seam regresses, both platform columns would capture
              // the host cascade and diff green forever.
              await page
                .waitForFunction(
                  `document.documentElement.getAttribute('data-os') === '${platform}' && document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
                  { timeout: 10_000 },
                )
                .catch(() => {
                  throw new Error(
                    `renderer never reached data-os=${platform} theme=${theme}; the capture would have measured the wrong cascade`,
                  );
                });
              return JSON.parse(await evaluate(CAPTURE_EXPR));
            },
          );
        let base;
        let current;
        try {
          // Both sides concurrently: the launcher attaches to the window it
          // spawned (not a port), so two live fixture windows cannot cross.
          [base, current] = await Promise.all([
            capture(baseDesktopDir),
            capture(join(ROOT, 'apps', 'desktop')),
          ]);
        } catch (err) {
          console.log(`FAIL ${key}: ${err.message}`);
          failures += 1;
          continue;
        }
        compared += 1;
        const baseRecords = base.records;
        const records = current.records;
        captures.set(`${route.id}.${theme}.${platform}`, records);
        // An omission rule that never matches silently inflates every record.
        for (const dead of findDeadOmissionRules(current.omission)) {
          failures += 1;
          console.log(
            `FAIL ${key}: "${dead.property}" never matched its INITIAL_VALUES entry across ${dead.sampled} sampled elements — the entry does not match what Chromium serialises`,
          );
        }
        const changes = diffRecords(baseRecords, records);
        if (changes.length === 0) {
          console.log(`ok   ${key} (${records.length} elements)`);
          continue;
        }
        failures += 1;
        const { text, structural } = summarise(changes, baseRecords.length);
        console.log(`FAIL ${key}: ${text}`);
        if (structural) {
          console.log(
            '  note: most of the base capture was replaced rather than changed, which is what inserting or removing a wrapper element looks like — element identity is the path through the tree, so everything below the edit is re-keyed. Compare the surviving `changed` entries; the removed/added pairs are the same elements under new paths.',
          );
        }
        for (const change of changes.slice(0, 40)) console.log(formatChange(change));
        if (changes.length > 40) console.log(`  … ${changes.length - 40} more`);
      }
    }
  }
  // Anchors for the regressions salvaged from the mega-branch. Losing one
  // means the harness stopped watching a place that has already broken once.
  for (const entry of checkSalvagedAnchors(captures)) {
    failures += 1;
    console.log(
      `FAIL salvaged anchor "${entry.anchor}" is gone from ${entry.route}: nothing now watches the spot where ${entry.commit} fixed "${entry.regression}"`,
    );
  }
  console.log(
    failures === 0
      ? `visual contract: ${compared} comparison(s) clean against ${args.against}`
      : `FAIL: ${failures} failure(s) across ${compared} comparison(s) against ${args.against}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// Only when run directly: the pure helpers above are imported by
// check-visual-contract.test.mjs, which must not launch Electron. Compared
// through pathToFileURL, not string concatenation — a checkout path with a
// space or non-ASCII segment percent-encodes in import.meta.url, and the
// mismatch would make this instrument exit 0 having measured nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
