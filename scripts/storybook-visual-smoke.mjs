/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditAxTree } from './ax-tree-audit.mjs';

const RENDER_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const NARROW_RENDER_VIEWPORT = Object.freeze({ width: 720, height: 900 });
const REQUIRED_COMPUTER_USE_STORY_IDS = new Set([
  'product-accessibility-dialogs--create-scheduled-task',
  'product-accessibility-dialogs--mermaid-fullscreen',
  'product-accessibility-dialogs--rename-conversation',
  'product-accessibility-overlays--bot-onboarding-qr',
  'product-accessibility-overlays--side-chat-close',
  'product-accessibility-overlays--wechat-login-qr',
  'product-accessibility-runtime-surfaces--active-terminal',
  'product-accessibility-runtime-surfaces--browser-loaded',
  'product-accessibility-runtime-surfaces--html-artifact',
  'product-accessibility-runtime-surfaces--remote-project-directory',
  'product-accessibility-runtime-surfaces--runtime-host-ssh-terminal',
  'product-module-hubs--extensions-mcp-editor',
  'product-module-hubs--extensions-mcp-inspector',
  'product-module-hubs--extensions-mcp-narrow',
  'product-module-hubs--extensions-skills-narrow',
  'product-module-hubs--scheduled-daily-review-report',
  'product-module-hubs--scheduled-tasks-narrow',
  'product-module-hubs--scheduled-tasks-inspector',
  'product-onboarding--narrow-window',
  'product-settings-pages--memory-populated',
  'product-settings-pages--permission-center-diagnostics-expanded',
  'product-settings-pages--subagent-editor',
  'product-settings-pages--daily-review-narrow',
  'product-settings-pages--usage-narrow',
  'product-settings-providers--add-provider',
  'product-settings-providers--connection-detail-page',
  'product-sidebar-session-list--long-titles-and-narrow',
  'product-shell-official-appshell--native-conversation',
  'product-shell-official-appshell--waiting-for-permission',
]);

// This is a catalog render and accessibility-tree health check.
// Story `play` functions do run: many stories reach their named final state
// only by opening an inspector, dialog, selector, or disclosure. The smoke
// waits for Storybook's completion event before reading the AX tree.

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
  url.searchParams.set('globals', 'colorScheme:light');
  return url.href;
}

export function storyViewport(storyId) {
  return storyId.includes('narrow') ? NARROW_RENDER_VIEWPORT : RENDER_VIEWPORT;
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
    await page.setViewportSize(storyViewport(job.storyId));
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
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.closest('[aria-hidden="true"]') || active.closest('[inert]'))
      ) {
        failures.push('focus is inside an aria-hidden or inert surface');
      }
      const dialogs = [
        ...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog'),
      ].filter((dialog) => {
        if (!(dialog instanceof HTMLElement)) return false;
        if (dialog instanceof HTMLDialogElement) return dialog.open;
        if (dialog.getAttribute('aria-modal') !== 'true') return false;
        const style = getComputedStyle(dialog);
        return (
          !dialog.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          dialog.getClientRects().length > 0
        );
      });
      if (
        dialogs.length > 0 &&
        active instanceof HTMLElement &&
        !dialogs.some((dialog) => dialog.contains(active))
      ) {
        failures.push('visible dialog does not own focus after rendering');
      }
      if (dialogs.length > 1) {
        failures.push(`multiple visible modal dialogs remain open (${dialogs.length})`);
      }
      return { failures };
    });
    browserFailures.push(...result.failures);
    const cdp = await page.context().newCDPSession(page);
    try {
      const axTree = await cdp.send('Accessibility.getFullAXTree');
      const audit = auditAxTree(axTree.nodes);
      if (audit.problems.length > 0) {
        browserFailures.push(`AX audit failed: ${JSON.stringify(audit.problems)}`);
      }
    } finally {
      await cdp.detach();
    }
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
  const storyIds = new Set(jobs.map((job) => job.storyId));
  const missingRequiredStories = [...REQUIRED_COMPUTER_USE_STORY_IDS].filter(
    (storyId) => !storyIds.has(storyId),
  );
  if (missingRequiredStories.length > 0) {
    throw new Error(
      `Computer Use story inventory is missing: ${missingRequiredStories.join(', ')}`,
    );
  }
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
