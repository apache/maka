// Interactive hit-test contract for the Astryx renderer migration (#1565, PR 0).
//
// The mega-branch's worst regressions were controls that render correctly and
// refuse clicks: an overlay with the wrong stacking, a pointer-events trap, a
// drag region swallowing the event. None of that is visible in a screenshot or
// in a computed-style snapshot, so it gets its own contract.
//
// #1565 proposes probing the drag region with a real click and watching for a
// side effect. That was tried and abandoned: a fixture window is hidden, and
// an unmapped window never routes synthesized input through the browser's
// hit-testing path, so every target reads as swallowed. Making the window
// visible to fix that turns the check into something that steals focus and
// fires real product actions — one probe opened a native file dialog and hung
// the run. So this asks the browser what is at a point instead of clicking it.
//
// The window-drag question is NOT asked here. `e2e/window-titlebar.spec.ts`
// already answers it in CI, against the rendered geometry, with the document
// order Chromium actually composes drag rects in — and `.maka-window-titlebar`
// is the only element in the product allowed to declare `drag`, so the
// titlebar band that spec sweeps is the whole surface where the question
// exists. This file covers what that spec does not: whether a control
// anywhere in the window can be reached at all.
//
//   node scripts/check-hit-test.mjs               # all routes
//   node scripts/check-hit-test.mjs --route chat
//
// Migration-only scaffolding: not in CI, removed in PR 14.
import { pathToFileURL } from 'node:url';
import { ROUTES, hook } from './contract-routes.mjs';
import { withFixtureWindow } from './fixture-window.mjs';

// #1565's selector list.
const INTERACTIVE_SELECTOR =
  'button, [role=button], a[href], input, textarea, select, [role=menuitem], [role=tab], [tabindex]:not([tabindex="-1"])';

const PROBE_EXPR = `(() => {
  // Every ancestor is consulted by several probes and shared by many
  // elements. Without memoising, a dense page runs thousands of
  // getComputedStyle/getBoundingClientRect calls, each forcing layout — the
  // providers route took over a minute and timed out. The page is frozen for
  // the duration of the capture, so the cached values stay valid.
  const styleCache = new Map();
  const rectCache = new Map();
  const styleOf = (el) => {
    let value = styleCache.get(el);
    if (!value) {
      value = getComputedStyle(el);
      styleCache.set(el, value);
    }
    return value;
  };
  const rectOf = (el) => {
    let value = rectCache.get(el);
    if (!value) {
      value = el.getBoundingClientRect();
      rectCache.set(el, value);
    }
    return value;
  };
  const elements = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})];
  const label = (el) =>
    (el.getAttribute('aria-label') ||
      el.getAttribute('data-testid') ||
      el.textContent ||
      el.getAttribute('name') ||
      el.tagName).trim().slice(0, 40);
  const signature = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [node];
      parts.unshift(siblings.length > 1 ? tag + ':' + (siblings.indexOf(node) + 1) : tag);
    }
    return 'body>' + parts.join('>');
  };
  // An open overlay legitimately covers the controls behind it. Probing those
  // would report the overlay as a hit failure on every route that opens one,
  // so restrict the probe to the overlay's own subtree while it is up. This
  // also keeps the probe away from the light-dismiss race that the Astryx
  // DropdownMenu guards with its ~50ms lastHideTimeRef window: nothing here
  // clicks a trigger, and the elements behind a modal are never probed.
  // [open] only exists on a native <dialog>; a React-rendered div[role=dialog]
  // never has it, which is how the settings modal went undetected and every
  // control behind it got reported as unhittable. role=listbox is excluded on
  // purpose: inline lists carry it too, and treating one as an overlay would
  // silently shrink the probe to a list.
  // data-modal="true" is the product's own declaration that a surface owns
  // the window (settings-surface.tsx sets it); it survives a component
  // migration in a way a class name does not.
  const overlay = [
    ...document.querySelectorAll(
      '[data-modal="true"], [role=dialog], [role=alertdialog], dialog[open], [role=menu], ${hook('search-modal')}',
    ),
  ].find((el) => {
    const box = rectOf(el);
    const css = styleOf(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      css.visibility !== 'hidden' &&
      css.display !== 'none' &&
      Number.parseFloat(css.opacity) > 0
    );
  });
  const inScope = (el) => !overlay || overlay.contains(el) || el.contains(overlay);

  // The part of an element a pointer could actually reach: its box clipped by
  // every scrolling or hidden-overflow ancestor, then by the viewport. A row
  // scrolled half out of its list still has a hittable strip, and probing the
  // clipped-away half would report the scroll container as the hit.
  const reachableRect = (el) => {
    const rect = rectOf(el);
    let left = rect.left;
    let top = rect.top;
    let right = rect.right;
    let bottom = rect.bottom;
    // A fixed element is laid out against the viewport, so no ancestor box
    // clips it.
    if (styleOf(el).position !== 'fixed') {
      for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        const style = styleOf(node);
        if (style.overflow === 'visible' && style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = rectOf(node);
        // display:contents reports an empty box while clipping nothing. A real
        // zero-size overflow container is different: it is how collapsed
        // Astryx content leaves its descendants mounted but unreachable.
        if (style.display === 'contents') continue;
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
        if (style.position === 'fixed') break;
      }
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, innerWidth);
    bottom = Math.min(bottom, innerHeight);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const results = [];
  // Why each element left the probe, so a shrinking probe set is visible
  // rather than being reported as a cleaner run.
  const skipped = { invisible: 0, outOfScope: 0, disabled: 0, transparent: 0, clipped: 0 };
  let probed = 0;
  for (const el of elements) {
    const rect = rectOf(el);
    const style = styleOf(el);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      Number.parseFloat(style.opacity) === 0
    ) { skipped.invisible += 1; continue; }
    if (!inScope(el)) { skipped.outOfScope += 1; continue; }
    // Disabled controls are meant to reject input; their opacity is styling,
    // not a defect.
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
      skipped.disabled += 1;
      continue;
    }

    // Walk the ancestry once for the diagnostics #1565 asks for: a
    // pointer-events:none link, a hidden ancestor, or a compounded opacity
    // that the element itself does not show.
    let blocker = null;
    let opacityProduct = 1;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const ancestorStyle = styleOf(node);
      opacityProduct *= Number.parseFloat(ancestorStyle.opacity);
      if (!blocker && node !== el) {
        if (ancestorStyle.pointerEvents === 'none') blocker = { reason: 'pointer-events', at: signature(node) };
        else if (ancestorStyle.visibility === 'hidden') blocker = { reason: 'visibility', at: signature(node) };
      }
    }
    opacityProduct = Math.round(opacityProduct * 1000) / 1000;
    // Fully transparent through an ancestor means invisible, not unclickable:
    // this is how the onboarding surface hides the app behind it. Nothing to
    // assert about a control nobody can see.
    if (opacityProduct === 0) { skipped.transparent += 1; continue; }

    // Scrolled out of view, or clipped to nothing.
    const reach = reachableRect(el);
    if (reach.width <= 0 || reach.height <= 0) { skipped.clipped += 1; continue; }
    probed += 1;

    // Corner probes must clear the border radius, or a pill-shaped control
    // reports its own parent as the hit at every corner. The arc passes 0.29r
    // from the corner, so half the radius is comfortably inside it.
    const radius = Math.max(
      Number.parseFloat(style.borderTopLeftRadius) || 0,
      Number.parseFloat(style.borderTopRightRadius) || 0,
      Number.parseFloat(style.borderBottomLeftRadius) || 0,
      Number.parseFloat(style.borderBottomRightRadius) || 0,
    );
    const inset = Math.min(
      Math.max(2, radius * 0.5),
      reach.width / 2 - 0.5,
      reach.height / 2 - 0.5,
    );
    const points = [
      ['center', reach.left + reach.width / 2, reach.top + reach.height / 2],
      ['top-left', reach.left + inset, reach.top + inset],
      ['top-right', reach.right - inset, reach.top + inset],
      ['bottom-left', reach.left + inset, reach.bottom - inset],
      ['bottom-right', reach.right - inset, reach.bottom - inset],
    ];
    const misses = [];
    for (const [name, x, y] of points) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) continue;
      misses.push({
        point: name,
        hit: hit ? hit.tagName.toLowerCase() + '.' + (hit.className || '').split(' ')[0] : null,
      });
    }
    // #1565 asks for all five points. On a clean main that standard is not
    // reachable: sibling chrome legitimately overlaps a couple of edge pixels
    // (a workbar resize handle sits on top of the panel's own corner), which
    // would report a control nobody has trouble clicking. Treat the centre as
    // the hard requirement and corners as corroboration — three lost corners
    // means something is actually covering the control, one means the border
    // has a neighbour.
    const centerMissed = misses.some((miss) => miss.point === 'center');
    const cornersMissed = misses.length - (centerMissed ? 1 : 0);
    const unhittable = centerMissed || cornersMissed >= 3;

    if (!unhittable && !blocker && opacityProduct === 1) continue;
    results.push({
      path: signature(el),
      label: label(el),
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      ...(unhittable ? { misses } : {}),
      ...(blocker ? { blocker } : {}),
      ...(opacityProduct !== 1 ? { opacityProduct } : {}),
    });
  }
  // \`probed\` counts what was actually probed, not what the selector matched.
  // Reporting the raw match count read as full coverage while more than half
  // the elements had been filtered out — and a migration that filters MORE
  // would have looked like it was passing harder.
  return JSON.stringify({
    matched: elements.length,
    probed,
    skipped,
    overlay: overlay ? overlay.className || overlay.tagName : null,
    findings: results,
  });
})()`;

export class HitTestArgumentError extends Error {}

export function parseHitTestArgs(argv) {
  const args = { routes: null };
  const routeIds = ROUTES.map((route) => route.id);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--route') {
      // Closed set, checked per value. Filtering later and failing only when
      // NOTHING matched let `--route chat --route chatt` drop the typo and
      // exit 0 as "1 route(s) clean" — a coverage tool must not shrink the
      // requested coverage silently.
      const next = argv[++i];
      if (!routeIds.includes(next)) {
        throw new HitTestArgumentError(`[hit-test] --route must be one of: ${routeIds.join(', ')}`);
      }
      (args.routes ??= []).push(next);
    } else if (arg === '--help' || arg === '-h') {
      return {
        help: `Usage: check-hit-test.mjs [--route id]...\n\nRoutes: ${routeIds.join(', ')}\n`,
        routes: null,
      };
    } else {
      throw new HitTestArgumentError(`[hit-test] unknown arg: ${arg}`);
    }
  }
  return args;
}

// elementFromPoint only agrees with getBoundingClientRect once the window is
// mapped — against a hidden fixture window it reports unrelated elements and
// buries the run in false positives. It does not need foreground focus, so the
// launcher maps the window inactive while the app stays out of the Dock.
//
// No retry. An earlier version retried once on any error, which also swallowed
// a genuine renderer exception in the probe and reported the second identical
// failure as if it were new information. `playwright.config.ts` states the
// house rule for the sibling harness: flakes should fail loudly.
async function probeRoute(route) {
  return withFixtureWindow(
    route.scenario,
    { theme: 'light', mapWindowInactive: true, readySelector: route.ready },
    async ({ evaluate }) => JSON.parse(await evaluate(PROBE_EXPR)),
  );
}

function coverage(report) {
  const dropped = Object.entries(report.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  const scope = report.overlay ? `, scoped to overlay ${report.overlay}` : '';
  return `${report.probed} of ${report.matched} probed${dropped ? ` (${dropped})` : ''}${scope}`;
}

async function main(argv) {
  let args;
  try {
    args = parseHitTestArgs(argv);
  } catch (error) {
    if (!(error instanceof HitTestArgumentError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (args.help) {
    console.log(args.help);
    return 0;
  }
  const routes = args.routes ? ROUTES.filter((route) => args.routes.includes(route.id)) : ROUTES;
  let failures = 0;
  for (const [index, route] of routes.entries()) {
    // These windows are mapped, and macOS does not hand the next one a
    // compositor while the last is still tearing down: booting them back to
    // back produced CDP connect failures and renderer timeouts that a gap
    // makes go away. Cheap next to a 13s boot.
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const report = await probeRoute(route);
      const problems = report.findings.length;
      if (problems === 0) {
        console.log(`ok   ${route.id} (${coverage(report)})`);
        continue;
      }
      failures += 1;
      console.log(`FAIL ${route.id}: ${problems} finding(s), ${coverage(report)}`);
      for (const finding of report.findings.slice(0, 20)) {
        const parts = [];
        if (finding.misses) {
          parts.push(
            `unhittable at ${finding.misses.map((m) => `${m.point}→${m.hit ?? 'nothing'}`).join(', ')}`,
          );
        }
        if (finding.blocker) parts.push(`${finding.blocker.reason} on ${finding.blocker.at}`);
        if (finding.opacityProduct !== undefined) {
          parts.push(`ancestor opacity product ${finding.opacityProduct}`);
        }
        console.log(`  "${finding.label}" ${finding.path}\n      ${parts.join('; ')}`);
      }
      if (report.findings.length > 20) console.log(`  … ${report.findings.length - 20} more`);
    } catch (err) {
      console.log(`FAIL ${route.id}: ${err.message}`);
      failures += 1;
    }
  }
  console.log(
    failures === 0
      ? `hit-test contract: ${routes.length} route(s) clean`
      : `FAIL: ${failures} route(s)`,
  );
  return failures === 0 ? 0 : 1;
}

// Only when run directly. pathToFileURL, not string concatenation: a
// percent-encoding path segment (a space, a non-ASCII directory) would
// otherwise make the direct run a silent no-op that exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
