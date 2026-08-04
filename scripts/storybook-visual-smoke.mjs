import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRODUCT_VIEWPORTS = Object.freeze({
  wide: Object.freeze({ width: 1280, height: 900 }),
  compact: Object.freeze({ width: 820, height: 900 }),
  floor: Object.freeze({ width: 480, height: 900 }),
});

// A surface listed here cannot be switched off by deleting its manifest entry:
// the validator fails instead. Without that, a guard is only as durable as the
// line that opts into it.
const REQUIRED_PRODUCT_SURFACES = Object.freeze([
  'settings',
  'skills',
  'mcp',
  'planReminders',
  'dailyReview',
  'sessionContext',
  'composer',
]);

const PRODUCT_CHECKS = new Set([
  'composer-focus-ownership',
  'plan-reminder-row',
  'session-context-layer',
]);

function fail(message) {
  throw new Error(`Product Storybook manifest: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCoverageManifest(manifest, storyIndex) {
  if (!isRecord(manifest) || manifest.version !== 1) fail('version must be 1');
  if (!isRecord(manifest.viewports)) fail('viewports must be an object');
  if (!isRecord(manifest.surfaces)) fail('surfaces must be an object');
  if (!isRecord(storyIndex?.entries)) fail('built Storybook index has no entries');

  for (const [name, expected] of Object.entries(PRODUCT_VIEWPORTS)) {
    const actual = manifest.viewports[name];
    if (!isRecord(actual) || actual.width !== expected.width || actual.height !== expected.height) {
      fail(`${name} viewport must be ${expected.width}x${expected.height}`);
    }
  }

  for (const surface of REQUIRED_PRODUCT_SURFACES) {
    if (!isRecord(manifest.surfaces[surface])) fail(`missing required surface: ${surface}`);
  }

  const jobs = [];
  for (const [surface, entry] of Object.entries(manifest.surfaces)) {
    if (!isRecord(entry)) fail(`${surface} must be an object`);
    if (typeof entry.storyId !== 'string' || entry.storyId.length === 0) {
      fail(`${surface} must identify a story id`);
    }
    if (typeof entry.productionHost !== 'string' || entry.productionHost.length === 0) {
      fail(`${surface} must identify its production host`);
    }
    if (typeof entry.state !== 'string' || entry.state.length === 0) {
      fail(`${surface} must identify its user-reachable state`);
    }
    if (storyIndex.entries[entry.storyId]?.type !== 'story') {
      fail(`unknown story id: ${entry.storyId}`);
    }

    const requiredViewports = Array.isArray(entry.viewports) ? entry.viewports : [];
    const optOuts = isRecord(entry.viewportOptOuts) ? entry.viewportOptOuts : {};
    const viewportSizes = isRecord(entry.viewportSizes) ? entry.viewportSizes : {};
    const colorSchemes = Array.isArray(entry.colorSchemes) ? entry.colorSchemes : ['light'];
    const checks = Array.isArray(entry.checks) ? entry.checks : [];
    for (const check of checks) {
      if (!PRODUCT_CHECKS.has(check)) fail(`${surface} uses unknown check: ${String(check)}`);
    }
    if (
      colorSchemes.length === 0 ||
      colorSchemes.some((scheme) => scheme !== 'light' && scheme !== 'dark')
    ) {
      fail(`${surface} colorSchemes must contain light or dark`);
    }
    for (const viewport of requiredViewports) {
      if (!(viewport in PRODUCT_VIEWPORTS)) fail(`${surface} uses unknown viewport: ${viewport}`);
    }
    for (const viewport of Object.keys(PRODUCT_VIEWPORTS)) {
      if (requiredViewports.includes(viewport)) {
        const size = viewportSizes[viewport] ?? PRODUCT_VIEWPORTS[viewport];
        if (
          !isRecord(size) ||
          !Number.isInteger(size.width) ||
          !Number.isInteger(size.height) ||
          size.width <= 0 ||
          size.height <= 0
        ) {
          fail(`${surface} ${viewport} viewport override must have positive integer dimensions`);
        }
        for (const colorScheme of colorSchemes) {
          jobs.push({
            surface,
            storyId: entry.storyId,
            viewport,
            size,
            colorScheme,
            checks,
            productionHost: entry.productionHost,
            state: entry.state,
          });
        }
        continue;
      }
      if (typeof optOuts[viewport] !== 'string' || optOuts[viewport].trim().length === 0) {
        fail(`${surface} must cover or explain its ${viewport} viewport opt-out`);
      }
    }
  }
  return jobs;
}

function describeBrowserValue(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return String(value);
}

function installStorybookSmokeProbe({ storyId }) {
  const smoke = {
    finished: false,
    failures: [],
    connected: false,
  };
  Object.defineProperty(window, '__makaStorybookSmoke', {
    configurable: true,
    value: smoke,
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    smoke.failures.push(
      `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  });

  const eventStoryId = (payload) => (typeof payload === 'string' ? payload : payload?.storyId);
  const belongsToStory = (payload) => {
    const emittedStoryId = eventStoryId(payload);
    return emittedStoryId === undefined || emittedStoryId === storyId;
  };
  const eventMessage = (payload) => {
    const error = payload?.error ?? payload;
    return error instanceof Error ? error.message : String(error?.message ?? error);
  };
  const connect = () => {
    const channel = window.__STORYBOOK_PREVIEW__?.channel;
    if (!channel) {
      window.setTimeout(connect, 0);
      return;
    }
    smoke.connected = true;
    channel.on('storyFinished', (payload) => {
      if (!belongsToStory(payload)) return;
      if (payload?.status === 'error') {
        smoke.failures.push(`storyFinished: ${eventMessage(payload)}`);
      } else {
        smoke.finished = true;
      }
    });
    for (const eventName of [
      'storyErrored',
      'storyThrewException',
      'playFunctionThrewException',
      'unhandledErrorsWhilePlaying',
      'storyMissing',
    ]) {
      channel.on(eventName, (payload) => {
        if (belongsToStory(payload)) {
          smoke.failures.push(`${eventName}: ${eventMessage(payload)}`);
        }
      });
    }
  };
  connect();
}

async function smokeStory(page, baseUrl, job, options = {}) {
  const prefix = `[${job.storyId} @ ${job.viewport}]`;
  const browserFailures = [];
  const onConsole = (message) => {
    if (message.type() === 'error') browserFailures.push(`console.error: ${message.text()}`);
  };
  const onPageError = (error) => {
    browserFailures.push(`uncaught page error: ${describeBrowserValue(error)}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    await page.addInitScript(installStorybookSmokeProbe, { storyId: job.storyId });

    await page.setViewportSize(job.size);
    const globals = `colorScheme:${job.colorScheme ?? 'light'}`;
    await page.goto(
      `${baseUrl}/iframe.html?id=${encodeURIComponent(job.storyId)}&viewMode=story&globals=${encodeURIComponent(globals)}`,
      {
        waitUntil: 'load',
      },
    );

    try {
      await page.waitForFunction(
        () => {
          const smoke = window.__makaStorybookSmoke;
          return smoke?.finished === true || smoke?.failures.length > 0;
        },
        undefined,
        { timeout: options.timeoutMs ?? 15_000 },
      );
    } catch (error) {
      if (browserFailures.length === 0) {
        browserFailures.push(`story did not finish render/play: ${describeBrowserValue(error)}`);
      }
    }

    if (job.checks?.includes('plan-reminder-row')) {
      try {
        await page.waitForSelector('.maka-plan-list-row', { state: 'visible', timeout: 5_000 });
      } catch {
        browserFailures.push('plan reminder rows did not finish rendering');
      }
    }

    const result = await page.evaluate(
      ({ checks, colorScheme }) => {
        const root = document.querySelector('#storybook-root');
        const failures = [...(window.__makaStorybookSmoke?.failures ?? [])];
        if (
          colorScheme === 'dark' &&
          (!document.documentElement.classList.contains('dark') ||
            getComputedStyle(document.documentElement).colorScheme !== 'dark')
        ) {
          failures.push('dark color scheme was not applied to the production root');
        }
        // The context layer is built from the production derive helpers, which
        // return undefined unless the story's session list really establishes
        // the lineage. Without this the surface would still pass while showing
        // no banner and no revision counter at all — the story would be a lie
        // that renders. The layer must also survive the narrow viewports, which
        // is the reason it is smoked at three of them.
        if (checks.includes('session-context-layer')) {
          const layer = document.querySelector('.maka-session-context');
          if (!layer) {
            failures.push('session context layer is missing');
          } else {
            const isVisible = (element) => {
              if (!element) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden'
              );
            };
            // OverflowList keeps a hidden measurement copy of every item, so
            // ask whether ANY copy is visible — querySelector alone would read
            // the measurement clone and report a rendered item as missing.
            const anyVisible = (selector) => [...layer.querySelectorAll(selector)].some(isVisible);

            if (!anyVisible('.maka-session-context__breadcrumbs')) {
              failures.push('branch breadcrumbs are missing — deriveBranchBanner returned nothing');
            }
            // Goal, memory and the revision counter share that OverflowList, so
            // a narrow viewport is allowed to move them into the MoreMenu — but
            // not to drop them. Absent from both places means the state the
            // manifest names is not on screen at all.
            const inOverflowMenu = anyVisible(
              '[data-slot="more-menu"], .astryx-more-menu, button[aria-haspopup="menu"]',
            );
            for (const [selector, label] of [
              ['.maka-session-context__revision', 'revision navigation'],
              ['.maka-session-context__goal', 'goal indicator'],
            ]) {
              if (!anyVisible(selector) && !inOverflowMenu) {
                failures.push(`${label} is neither visible nor collapsed into the overflow menu`);
              }
            }
            if (!anyVisible('.maka-session-context__cluster')) {
              failures.push('session context cluster rendered no items');
            }
            if (layer.scrollWidth > layer.clientWidth + 1) {
              failures.push(
                `session context layer overflows horizontally (${layer.scrollWidth} > ${layer.clientWidth})`,
              );
            }
          }
        }
        if (checks.includes('composer-focus-ownership')) {
          const editor = document.querySelector('.maka-composer-editor > [contenteditable="true"]');
          const composer = editor?.closest('[data-maka-contract="composer-inner"]');
          if (!(editor instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
            failures.push('composer editor or Astryx focus surface is missing');
          } else {
            const focusAncestors = [];
            for (let element = editor.parentElement; element; element = element.parentElement) {
              focusAncestors.push(element);
              if (element === composer) break;
            }
            const visibleFocusChrome = (element) => {
              const style = getComputedStyle(element);
              const border = ['Top', 'Right', 'Bottom', 'Left'].flatMap((side) => {
                const width = Number.parseFloat(style[`border${side}Width`]);
                return width > 0
                  ? [
                      `${side}:${style[`border${side}Style`]} ${width}px ${style[`border${side}Color`]}`,
                    ]
                  : [];
              });
              return {
                border,
                boxShadow: style.boxShadow === 'none' ? null : style.boxShadow,
                outline:
                  style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) === 0
                    ? null
                    : `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
              };
            };
            const restingChrome = focusAncestors.map(visibleFocusChrome);
            editor.focus();
            // Resolve Astryx's focus transition to its final state before
            // comparing computed presentation. The contract is the visible
            // owner, not an intermediate animation frame.
            for (const element of focusAncestors) {
              void getComputedStyle(element).boxShadow;
              for (const animation of element.getAnimations()) animation.finish();
            }
            const focusedChrome = focusAncestors.map(visibleFocusChrome);
            const style = getComputedStyle(editor);
            const actual = {
              backgroundColor: style.backgroundColor,
              borderWidth: style.borderWidth,
              boxShadow: style.boxShadow,
              outlineStyle: style.outlineStyle,
            };
            const expected = {
              backgroundColor: 'rgba(0, 0, 0, 0)',
              borderWidth: '0px',
              boxShadow: 'none',
              outlineStyle: 'none',
            };
            for (const [property, expectedValue] of Object.entries(expected)) {
              if (actual[property] !== expectedValue) {
                failures.push(
                  `composer editor ${property} must be ${expectedValue}, got ${actual[property]}`,
                );
              }
            }
            if (document.activeElement !== editor) {
              failures.push('composer editor did not retain focus');
            }
            const visibleOwner = focusedChrome.some((focused, index) => {
              const changed = JSON.stringify(focused) !== JSON.stringify(restingChrome[index]);
              const visible =
                focused.border.length > 0 || focused.boxShadow !== null || focused.outline !== null;
              return changed && visible;
            });
            if (!visibleOwner) {
              failures.push(
                'no Astryx composer ancestor produced visible border, shadow, or outline focus feedback',
              );
            }
          }
        }
        if (checks.includes('plan-reminder-row')) {
          if (document.documentElement.scrollWidth > document.documentElement.clientWidth) {
            failures.push('document has horizontal overflow');
          }
          const rows = [...document.querySelectorAll('.maka-plan-list-row')];
          if (rows.length === 0) failures.push('plan reminder rows are missing');
          const checkElement = (element, label) => {
            const rect = element?.getBoundingClientRect();
            if (
              !element ||
              getComputedStyle(element).display === 'none' ||
              getComputedStyle(element).visibility === 'hidden' ||
              !rect ||
              rect.width <= 0 ||
              rect.left < -1 ||
              rect.right > document.documentElement.clientWidth + 1
            ) {
              failures.push(
                `${label} is hidden or clipped (${rect?.left ?? 'missing'}..${rect?.right ?? 'missing'} / ${document.documentElement.clientWidth})`,
              );
            }
          };
          for (const row of rows) {
            if (row.scrollWidth > row.clientWidth)
              failures.push('plan reminder row has horizontal overflow');
            /* Premium-row redesign: completed rows show their lifecycle as a
               StatusDot cluster; run messages live in the runs tab. */
            if (
              row.getAttribute('data-status') === 'completed' &&
              !row.querySelector('.maka-plan-status')
            ) {
              failures.push('completed plan reminder row is missing its lifecycle state');
            }
            for (const selector of ['.maka-plan-list-row-title', '.maka-plan-list-row-meta']) {
              checkElement(row.querySelector(selector), selector);
            }
            for (const selector of ['.maka-plan-status', '.maka-plan-list-row-countdown']) {
              const element = row.querySelector(selector);
              if (element) checkElement(element, selector);
            }
          }
          // The margin loop above runs zero times if countdowns stop rendering,
          // which would make the spacing contract pass by vacancy. Rows with a
          // scheduled next run are exactly the ones that must show one.
          const scheduledRows = rows.filter(
            (row) => row.getAttribute('data-status') === 'scheduled',
          );
          if (
            scheduledRows.length > 0 &&
            !rows.some((row) => row.querySelector('.maka-plan-list-row-countdown'))
          ) {
            failures.push(
              'no plan reminder row rendered a countdown, so its spacing went unchecked',
            );
          }
          if (document.documentElement.clientWidth >= 1100 && rows[0]) {
            /* Premium-row contract: a single flex row — leading switch, main
               column, trailing countdown/menu. Countdown right edges must
               align across rows so the trailing column reads as a column. */
            if (getComputedStyle(rows[0]).display !== 'flex') {
              failures.push('plan reminder wide row must lay out as a flex row');
            }
            const countdownRights = rows
              .map(
                (row) =>
                  row.querySelector('.maka-plan-list-row-countdown')?.getBoundingClientRect().right,
              )
              .filter((right) => typeof right === 'number')
              .map((right) => Math.round(right));
            if (
              countdownRights.length > 1 &&
              countdownRights.some((right) => Math.abs(right - countdownRights[0]) > 1)
            ) {
              failures.push(
                `plan reminder countdowns must right-align, got ${countdownRights.join(', ')}`,
              );
            }
          }
        }
        return {
          hasContent: Boolean(root?.innerHTML.trim()),
          failures,
        };
      },
      { checks: job.checks ?? [], colorScheme: job.colorScheme ?? 'light' },
    );
    browserFailures.push(...result.failures);
    if (!result.hasContent) browserFailures.push('story root rendered empty content');
    if (browserFailures.length > 0) {
      throw new Error(`${prefix} ${browserFailures.join('; ')}`);
    }
  } finally {
    page.off?.('console', onConsole);
    page.off?.('pageerror', onPageError);
  }
}

/**
 * Every story the manifest does NOT name, rendered once at wide/light.
 *
 * The manifest is a curated list — a dozen surfaces across viewports and colour
 * schemes, because those checks are expensive and only worth paying for where
 * layout actually varies. But that left every other story verified by nothing:
 * `build-storybook` bundles a story without mounting it, so a render that
 * throws, a play function that rejects, or a console error ships green.
 *
 * This pass is deliberately shallow. It answers one question — does the story
 * still mount and finish its play function without errors — and leaves
 * viewport, colour-scheme and surface-specific assertions to the manifest.
 */
function catalogJobs(storyIndex, manifestJobs) {
  const covered = new Set(manifestJobs.map((job) => job.storyId));
  return Object.values(storyIndex.entries)
    .filter((entry) => entry.type === 'story' && !covered.has(entry.id))
    .map((entry) => ({
      storyId: entry.id,
      viewport: 'catalog',
      size: PRODUCT_VIEWPORTS.wide,
      colorScheme: 'light',
    }));
}

/**
 * Every job is attempted and every story failure is collected, so one broken
 * story cannot hide the rest behind it. Only an infrastructure failure — a page
 * that cannot be opened or closed — is allowed to reject and abort the run.
 */
async function runJobs(browser, baseUrl, jobs, concurrency) {
  const queue = [...jobs];
  const failures = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const page = await browser.newPage();
      try {
        await smokeStory(page, baseUrl, job);
        process.stdout.write(`✓ ${job.storyId} @ ${job.viewport}\n`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        process.stdout.write(`✗ ${job.storyId} @ ${job.viewport}\n`);
      } finally {
        await page.close();
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function startStaticServer(staticDir) {
  const root = resolve(staticDir);
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      );
      const target = resolve(root, `.${requestPath === '/' ? '/index.html' : requestPath}`);
      if (relative(root, target).startsWith('..')) {
        response.writeHead(403).end();
        return;
      }
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Storybook server has no TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function runCli() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..');
  const staticDir = resolve(process.argv[2] ?? join(repoRoot, 'apps/desktop/storybook-static'));
  const manifestPath = resolve(
    process.argv[3] ?? join(repoRoot, 'apps/desktop/stories/product-smoke-manifest.json'),
  );
  const [manifest, storyIndex] = await Promise.all([
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(join(staticDir, 'index.json'), 'utf8').then(JSON.parse),
  ]);
  const jobs = validateCoverageManifest(manifest, storyIndex);
  const catalog = catalogJobs(storyIndex, jobs);
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const server = await startStaticServer(staticDir);
  const problems = [];
  try {
    // The manifest jobs run first and serially: they assert on layout geometry,
    // which is why they pin a viewport in the first place.
    problems.push(...(await runJobs(browser, server.baseUrl, jobs, 1)));
    problems.push(...(await runJobs(browser, server.baseUrl, catalog, 4)));
  } finally {
    await server.close();
    await browser.close();
  }
  if (problems.length > 0) {
    throw new Error(`${problems.length} story check(s) failed:\n${problems.join('\n')}`);
  }
  process.stdout.write(
    `Product Storybook smoke passed (${jobs.length} manifest check(s), ` +
      `${catalog.length} catalog render(s)).\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
