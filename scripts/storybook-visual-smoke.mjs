import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCT_VIEWPORTS = Object.freeze({
  wide: Object.freeze({ width: 1280, height: 900 }),
  compact: Object.freeze({ width: 820, height: 900 }),
  floor: Object.freeze({ width: 480, height: 900 }),
});

export const REQUIRED_PRODUCT_SURFACES = Object.freeze([
  'settings',
  'skills',
  'mcp',
  'planReminders',
  'dailyReview',
]);

function fail(message) {
  throw new Error(`Product Storybook manifest: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateCoverageManifest(manifest, storyIndex) {
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
    for (const viewport of requiredViewports) {
      if (!(viewport in PRODUCT_VIEWPORTS)) fail(`${surface} uses unknown viewport: ${viewport}`);
    }
    for (const viewport of Object.keys(PRODUCT_VIEWPORTS)) {
      if (requiredViewports.includes(viewport)) {
        jobs.push({
          surface,
          storyId: entry.storyId,
          viewport,
          size: PRODUCT_VIEWPORTS[viewport],
          productionHost: entry.productionHost,
          state: entry.state,
        });
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

export function installStorybookSmokeProbe({ storyId }) {
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

export async function smokeStory(page, baseUrl, job, options = {}) {
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
    await page.goto(`${baseUrl}/iframe.html?id=${encodeURIComponent(job.storyId)}&viewMode=story`, {
      waitUntil: 'load',
    });

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

    const result = await page.evaluate(() => {
      const root = document.querySelector('#storybook-root');
      return {
        hasContent: Boolean(root?.innerHTML.trim()),
        failures: window.__makaStorybookSmoke?.failures ?? [],
      };
    });
    if (result !== true) {
      browserFailures.push(...result.failures);
      if (!result.hasContent) browserFailures.push('story root rendered empty content');
    }
    if (browserFailures.length > 0) {
      throw new Error(`${prefix} ${browserFailures.join('; ')}`);
    }
  } finally {
    page.off?.('console', onConsole);
    page.off?.('pageerror', onPageError);
  }
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
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const server = await startStaticServer(staticDir);
  try {
    for (const job of jobs) {
      const page = await browser.newPage();
      try {
        await smokeStory(page, server.baseUrl, job);
        process.stdout.write(`✓ ${job.storyId} @ ${job.viewport}\n`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await server.close();
    await browser.close();
  }
  process.stdout.write(`Product Storybook smoke passed (${jobs.length} render/play checks).\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
