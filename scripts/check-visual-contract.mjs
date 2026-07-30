// Computed-style contract for the Astryx renderer migration (#1565, PR 0).
//
// Walks the representative fixture routes in light and dark, records a
// computed-style signature for every visible element, and compares the result
// against committed JSON baselines.
//
//   node scripts/check-visual-contract.mjs            # compare, exit 1 on diff
//   node scripts/check-visual-contract.mjs --update   # rewrite the baselines
//   node scripts/check-visual-contract.mjs --route chat --theme dark
//
// This gates NO-CHANGE, not correctness. A pre-existing visual bug on main is
// out of scope for the migration: "zero diff" means "the migration did not
// move this element", never "this element is right".
//
// Migration-only scaffolding. It is deliberately not wired into CI, following
// the check:chat-visual precedent, and is removed in PR 14 together with the
// maka.legacy layer.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFixtureWindow } from './fixture-cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = join(ROOT, 'apps', 'desktop', 'tests', 'visual-contract');

// The five representative routes from #1565. The issue names product routes;
// these are the MAKA_E2E_FIXTURE scenarios that actually open them on main —
// there is no scenario literally named "settings-providers" or "chat".
const ROUTES = [
  // Long chat session with the task workbar open.
  { id: 'chat', scenario: 'turn-narrative' },
  { id: 'settings-general', scenario: 'settings-general' },
  // Providers live under the 模型 settings section.
  { id: 'settings-providers', scenario: 'provider-workspace' },
  { id: 'mcp-hub', scenario: 'module-mcp' },
  // Empty profile, first launch.
  { id: 'onboarding', scenario: 'first-run' },
];
const THEMES = ['light', 'dark'];

// #1565 mandates the alignment properties (alignItems/justifyContent/
// placeItems/gap/gridArea) alongside the usual box and paint set: flex and
// grid misalignment is the regression class a style-only property set cannot
// see. Shorthands are recorded where Chromium resolves them, which keeps the
// baselines a third of the size of their longhand equivalents. Computed
// width/height are omitted because the recorded rect already carries the
// used box, and it also reflects transforms and flex stretching.
const PROPERTIES = [
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
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'backgroundImage',
  'alignItems',
  'justifyContent',
  'placeItems',
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
const INITIAL_VALUES = {
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
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  alignItems: 'normal',
  justifyContent: 'normal',
  placeItems: 'normal normal',
  gap: 'normal normal',
  gridArea: 'auto / auto / auto / auto',
};
const INHERITED_PROPERTIES = [
  'cursor',
  'pointerEvents',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
];

const CAPTURE_EXPR = `(() => {
  const PROPERTIES = ${JSON.stringify(PROPERTIES)};
  const INITIAL_VALUES = ${JSON.stringify(INITIAL_VALUES)};
  const INHERITED = new Set(${JSON.stringify(INHERITED_PROPERTIES)});
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
  const walk = (el, path, inherited) => {
    if (el.matches(DECORATION)) return;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ownInherited = {};
    for (const property of INHERITED) ownInherited[property] = roundPx(style[property]);
    // Only elements a reviewer could see. An invisible element that stays
    // invisible is not a visual contract, and skipping them keeps the
    // baselines to the part of the tree the migration can actually move.
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number.parseFloat(style.opacity) > 0;
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
      for (const property of PROPERTIES) {
        const value = roundPx(style[property]);
        if (value === '' || value == null) continue;
        if (INITIAL_VALUES[property] === value) continue;
        if (INHERITED.has(property) && inherited[property] === value) continue;
        record[property] = value;
      }
      out.push(record);
    }
    // Descend even through invisible parents: a zero-size wrapper can still
    // hold visible children (common for absolutely positioned overlays).
    const children = el.children;
    const counts = new Map();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      const index = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, index);
      walk(child, path + '>' + tag + (index > 1 ? ':' + index : ''), ownInherited);
    }
  };
  walk(document.body, 'body', {});
  return JSON.stringify(out);
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
  {
    commit: '9aad59740',
    regression: 'every session timestamp stacked above its title',
    route: 'chat',
    anchor: 'maka-list-row-meta',
  },
  {
    commit: '3dbd68ca7',
    regression: 'sidebar nav rows had two competing styling authorities',
    route: 'chat',
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

function checkSalvagedAnchors(baselines) {
  const missing = [];
  for (const entry of SALVAGED_ANCHORS) {
    const records = baselines.get(`${entry.route}.light`);
    if (!records) continue;
    const present = records.some((record) => (record.classes ?? '').includes(entry.anchor));
    if (!present) missing.push(entry);
  }
  return missing;
}

function parseArgs(argv) {
  const args = { update: false, routes: null, themes: null, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--update') args.update = true;
    else if (arg === '--route') (args.routes ??= []).push(argv[++i]);
    else if (arg === '--theme') (args.themes ??= []).push(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`[visual-contract] unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function baselinePath(routeId, theme) {
  return join(BASELINE_DIR, `${routeId}.${theme}.json`);
}

async function readBaseline(routeId, theme) {
  try {
    return JSON.parse(await readFile(baselinePath(routeId, theme), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Report every element that appeared, disappeared, or changed any recorded
// property — with the property names, so a reviewer can tell "this moved 4px"
// from "this lost its background".
function diffRecords(baseline, current) {
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
  return changes;
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
      `Usage: check-visual-contract.mjs [--update] [--route id]... [--theme light|dark]...\n\n` +
        `Routes: ${ROUTES.map((route) => route.id).join(', ')}\n` +
        `Baselines: ${relative(ROOT, BASELINE_DIR)}\n`,
    );
    return;
  }
  const routes = args.routes ? ROUTES.filter((route) => args.routes.includes(route.id)) : ROUTES;
  const themes = args.themes ?? THEMES;
  if (routes.length === 0) {
    console.error('[visual-contract] no matching route');
    process.exit(2);
  }
  await mkdir(BASELINE_DIR, { recursive: true });
  let failures = 0;
  let captured = 0;
  const baselines = new Map();
  for (const route of routes) {
    for (const theme of themes) {
      let records;
      try {
        records = await withFixtureWindow(route.scenario, { theme }, async ({ evaluate }) =>
          JSON.parse(await evaluate(CAPTURE_EXPR)),
        );
      } catch (err) {
        console.log(`FAIL ${route.id} ${theme}: ${err.message}`);
        failures += 1;
        continue;
      }
      captured += 1;
      baselines.set(`${route.id}.${theme}`, records);
      if (args.update) {
        await writeFile(baselinePath(route.id, theme), `${JSON.stringify(records, null, 1)}\n`);
        console.log(`wrote ${route.id} ${theme} (${records.length} elements)`);
        continue;
      }
      const baseline = await readBaseline(route.id, theme);
      if (!baseline) {
        console.log(`FAIL ${route.id} ${theme}: no baseline; run with --update`);
        failures += 1;
        continue;
      }
      const changes = diffRecords(baseline, records);
      if (changes.length === 0) {
        console.log(`ok   ${route.id} ${theme} (${records.length} elements)`);
        continue;
      }
      failures += 1;
      console.log(`FAIL ${route.id} ${theme}: ${changes.length} change(s)`);
      for (const change of changes.slice(0, 40)) console.log(formatChange(change));
      if (changes.length > 40) console.log(`  … ${changes.length - 40} more`);
    }
  }
  // Anchors for the regressions salvaged from the mega-branch. Losing one
  // means the harness stopped watching a place that has already broken once.
  for (const entry of checkSalvagedAnchors(baselines)) {
    failures += 1;
    console.log(
      `FAIL salvaged anchor "${entry.anchor}" is gone from ${entry.route}: nothing now watches the spot where ${entry.commit} fixed "${entry.regression}"`,
    );
  }

  // A stale baseline for a route that no longer exists is a silent hole in
  // the contract: it would keep passing while nothing checks it.
  if (!args.update && routes.length === ROUTES.length && themes.length === THEMES.length) {
    const expected = new Set(
      ROUTES.flatMap((route) => THEMES.map((theme) => `${route.id}.${theme}.json`)),
    );
    const present = (await readdir(BASELINE_DIR)).filter((name) => name.endsWith('.json'));
    for (const name of present) {
      if (!expected.has(name)) {
        console.log(`FAIL orphan baseline ${name}: no route captures it`);
        failures += 1;
      }
    }
  }
  console.log(
    failures === 0
      ? `visual contract: ${captured} capture(s) clean`
      : `FAIL: ${failures} of ${captured || routes.length * themes.length} capture(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
