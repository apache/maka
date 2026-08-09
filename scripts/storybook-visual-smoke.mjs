import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RENDER_VIEWPORT = Object.freeze({ width: 1280, height: 900 });

// This is intentionally a catalog health check, not a visual or product gate.
// Embedded Storybook disables every `play` function, so desktop interactions,
// geometry and responsive behaviour stay in their owning test harnesses.

function describeBrowserValue(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return String(value);
}

function installStorybookRenderProbe({ storyId }) {
  const smoke = {
    finished: false,
    failures: [],
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
    channel.on('storyFinished', (payload) => {
      if (!belongsToStory(payload)) return;
      if (payload?.status === 'error') {
        smoke.failures.push(`storyFinished: ${eventMessage(payload)}`);
      } else {
        smoke.finished = true;
      }
    });
    for (const eventName of ['storyErrored', 'storyThrewException', 'storyMissing']) {
      channel.on(eventName, (payload) => {
        if (belongsToStory(payload)) {
          smoke.failures.push(`${eventName}: ${eventMessage(payload)}`);
        }
      });
    }
  };
  connect();
}

export function catalogJobs(storyIndex) {
  const entries = storyIndex?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('Built Storybook index has no entries');
  }
  const jobs = Object.values(entries)
    .filter((entry) => entry?.type === 'story' && typeof entry.id === 'string')
    .map((entry) => ({ storyId: entry.id }));
  if (jobs.length === 0) throw new Error('Built Storybook index has no stories');
  return jobs;
}

export function storyUrl(baseUrl, storyId) {
  const url = new URL('/iframe.html', baseUrl);
  url.searchParams.set('id', storyId);
  url.searchParams.set('viewMode', 'story');
  url.searchParams.set('embed', 'true');
  url.searchParams.set('globals', 'colorScheme:light');
  return url.href;
}

async function smokeStory(page, baseUrl, job, options = {}) {
  const prefix = `[${job.storyId}]`;
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
    await page.addInitScript(installStorybookRenderProbe, { storyId: job.storyId });
    await page.setViewportSize(RENDER_VIEWPORT);
    await page.goto(storyUrl(baseUrl, job.storyId), { waitUntil: 'load' });

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
        browserFailures.push(`story did not finish rendering: ${describeBrowserValue(error)}`);
      }
    }

    const result = await page.evaluate(() => {
      const root = document.querySelector('#storybook-root');
      const failures = [...(window.__makaStorybookSmoke?.failures ?? [])];
      if (!(root instanceof HTMLElement) || root.innerHTML.trim().length === 0) {
        failures.push('storybook root is empty after render');
      }
      return { failures };
    });
    browserFailures.push(...result.failures);
    if (browserFailures.length > 0) {
      throw new Error(`${prefix} ${browserFailures.join('; ')}`);
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

async function runJobs(browser, baseUrl, jobs, concurrency) {
  const queue = [...jobs];
  const failures = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const page = await browser.newPage();
      try {
        await smokeStory(page, baseUrl, job);
        process.stdout.write(`✓ ${job.storyId}\n`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        process.stdout.write(`✗ ${job.storyId}\n`);
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

export async function startStaticServer(staticDir) {
  const root = resolve(staticDir);
  const server = createServer(async (request, response) => {
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
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
      if (requestPath === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }
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
  const storyIndex = await readFile(join(staticDir, 'index.json'), 'utf8').then(JSON.parse);
  const jobs = catalogJobs(storyIndex);
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const server = await startStaticServer(staticDir);
  let problems;
  try {
    problems = await runJobs(browser, server.baseUrl, jobs, 4);
  } finally {
    await server.close();
    await browser.close();
  }
  if (problems.length > 0) {
    throw new Error(`${problems.length} story render(s) failed:\n${problems.join('\n')}`);
  }
  process.stdout.write(`Storybook render smoke passed (${jobs.length} stories).\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
