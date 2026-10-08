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

/*
 * Local before/after pixel diff for the chat surface stories (#5794).
 *
 * This is the evidence loop for the A1 layout refactors tracked in #5793:
 * run `capture` on the tree before the change and once on the change, then
 * `compare` prints which stories moved pixels and writes a magenta-on-dim
 * diff image for each one that did.
 *
 *   npm --workspace @maka/desktop run build-storybook
 *   node scripts/storybook-visual-diff.mjs capture --out /tmp/maka-shots/before
 *   # ... make the layout change, rebuild storybook ...
 *   node scripts/storybook-visual-diff.mjs capture --out /tmp/maka-shots/after
 *   node scripts/storybook-visual-diff.mjs compare /tmp/maka-shots/before /tmp/maka-shots/after
 *
 * Keep both captures on the same machine: the font stack starts with
 * -apple-system, so a capture from another OS diffs on every glyph. Nothing
 * here runs in CI and no captured image belongs in the repository.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  installStorybookRenderProbe,
  startStaticServer,
  storyUrl,
  storyViewport,
} from './storybook-visual-smoke.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORYBOOK_DIR = 'apps/desktop/storybook-static';

// One frozen instant for every shot so the session rail's relative times
// ("3mo") and any date-derived copy are identical between runs.
const FIXED_TIME = '2025-06-02T12:00:00Z';
const COLOR_SCHEMES = Object.freeze(['light', 'dark']);
const SETTLE_MS = 250;
const STORY_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const MANIFEST_FILE = 'manifest.json';

// The chat surfaces the A1 refactors touch first (#5794). Product story ids,
// not display names, so `--stories` filters and shot filenames stay stable.
const DEFAULT_STORY_IDS = Object.freeze([
  'product-shell-official-appshell--native-conversation',
  'product-shell-official-appshell--streaming-turn',
  'product-shell-official-appshell--failed-turn-with-tool-error',
  'product-shell-official-appshell--provider-retrying',
  'product-shell-official-appshell--wide-assistant-prose',
  'product-shell-official-appshell--waiting-for-permission',
  'product-shell-official-appshell--new-chat-composer',
  'product-shell-official-appshell--empty-home',
  'product-markdown--transcript-turn',
  'product-markdown--rich-assistant-answer',
  'product-tool-activity--errors-and-permission-denied',
  'product-tool-activity--requires-bypass-recovery',
  'product-tool-activity--dense-mixed-results',
  'product-tool-activity--shell-command-surface',
  'product-tool-activity--edit-write-diff-rows',
  'product-tool-activity--edit-write-diff-details',
  'product-tool-activity--expanded-web-search-row',
  'product-tool-activity--contiguous-group',
  'product-tool-activity--contiguous-diff-group',
  'product-tool-activity--long-intent-group-narrow',
]);

// What `animations: 'disabled'` does in toHaveScreenshot, applied by hand
// because page.screenshot takes no such option. scroll-behavior joins the
// list because a mid-smooth-scroll capture lands on a different frame.
const STABLE_PAINT_CSS = `*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}`;

function installStablePaint(css) {
  const style = document.createElement('style');
  style.id = 'maka-shot-stable-paint';
  style.textContent = css;
  (document.head ?? document.documentElement).appendChild(style);
}

export function shotFileName(storyId, colorScheme) {
  return `${storyId}.${colorScheme}.png`;
}

/** Story × colour-scheme jobs; `stories` filters story ids by substring. */
export function shotJobs(storyIds, { stories, schemes } = {}) {
  const filters = Array.isArray(stories) && stories.length > 0 ? stories : null;
  const wanted = filters
    ? storyIds.filter((storyId) => filters.some((filter) => storyId.includes(filter)))
    : storyIds;
  const activeSchemes = Array.isArray(schemes) && schemes.length > 0 ? schemes : COLOR_SCHEMES;
  for (const scheme of activeSchemes) {
    if (!COLOR_SCHEMES.includes(scheme)) {
      throw new Error(
        `Unknown color scheme "${scheme}" (expected one of ${COLOR_SCHEMES.join(', ')})`,
      );
    }
  }
  return wanted.flatMap((storyId) =>
    activeSchemes.map((colorScheme) => ({ storyId, colorScheme })),
  );
}

async function readStoryIndex(storybookDir) {
  const indexPath = join(storybookDir, 'index.json');
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    throw new Error(
      `No built Storybook at ${storybookDir}. Build one first:\n` +
        '  npm --workspace @maka/desktop run build-storybook\n' +
        'or pass --storybook <dir> pointing at an existing build.',
    );
  }
  const entries = index?.entries;
  if (!entries || typeof entries !== 'object') {
    throw new Error(`${indexPath} has no story entries`);
  }
  return new Set(
    Object.values(entries)
      .filter((entry) => entry?.type === 'story')
      .map((entry) => entry.id),
  );
}

async function captureShot(browser, baseUrl, job, outDir) {
  const viewport = storyViewport(job.storyId);
  // A fresh context per shot: the stories share an origin, so reuse would let
  // one story's localStorage or session state reach the next one's paint.
  const context = await browser.newContext({
    viewport,
    colorScheme: job.colorScheme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    // Fixed Date, real timers: setFixedTime pins Date.now/new Date without
    // pausing setTimeout, so play functions and render gates still complete.
    await page.clock.setFixedTime(FIXED_TIME);
    await page.addInitScript(installStorybookRenderProbe, { storyId: job.storyId });
    await page.addInitScript(installStablePaint, STABLE_PAINT_CSS);
    await page.emulateMedia({ colorScheme: job.colorScheme, reducedMotion: 'reduce' });
    await page.goto(
      storyUrl(baseUrl, { storyId: job.storyId, colorScheme: job.colorScheme, palette: 'default' }),
      { waitUntil: 'load' },
    );
    const finished = await page
      .waitForFunction(
        () => {
          const smoke = window.__makaStorybookSmoke;
          return smoke?.finished === true || (smoke?.failures.length ?? 0) > 0;
        },
        undefined,
        { timeout: STORY_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);
    const failures = await page.evaluate(
      () => window.__makaStorybookSmoke?.failures ?? ['render probe missing'],
    );
    if (failures.length > 0) throw new Error(failures.join('; '));
    if (!finished) throw new Error(`story did not finish rendering within ${STORY_TIMEOUT_MS}ms`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(SETTLE_MS);
    const file = shotFileName(job.storyId, job.colorScheme);
    await page.screenshot({ path: join(outDir, file) });
    return { file, storyId: job.storyId, colorScheme: job.colorScheme, viewport };
  } finally {
    await context.close();
  }
}

async function runCapture(options) {
  const outDir = resolve(requiredOption(options, 'out'));
  const storybookDir = resolve(options.storybook ?? join(REPO_ROOT, DEFAULT_STORYBOOK_DIR));
  const storyIndex = await readStoryIndex(storybookDir);
  const filters = listOption(options.stories);
  const candidates = filters ? [...storyIndex] : [...DEFAULT_STORY_IDS];
  const jobs = shotJobs(candidates, {
    stories: filters,
    schemes: listOption(options.schemes) ?? undefined,
  });
  const missingDefaults = DEFAULT_STORY_IDS.filter((id) => !storyIndex.has(id));
  if (!filters && missingDefaults.length > 0) {
    process.stderr.write(
      `warning: catalog is missing default stories: ${missingDefaults.join(', ')}\n`,
    );
  }
  if (jobs.length === 0) {
    throw new Error(
      filters
        ? `No catalog story matched --stories ${filters.join(',')}`
        : 'The default story set matched nothing in this catalog',
    );
  }
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const server = await startStaticServer(storybookDir);
  const shots = [];
  const failures = [];
  try {
    await mkdir(outDir, { recursive: true });
    const queue = [...jobs];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const shot = await captureShot(browser, server.baseUrl, job, outDir);
          shots.push(shot);
          process.stdout.write(`✓ ${shot.file}\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ job, message });
          process.stderr.write(`✗ ${job.storyId} (${job.colorScheme}): ${message}\n`);
        }
      }
    });
    await Promise.all(workers);
  } finally {
    await server.close();
    await browser.close();
  }
  // Only the fields compare guards on: a capture from another OS or another
  // Chromium rasterizes different glyphs, and the warning below is the only
  // thing standing between that and a page of meaningless diffs. `shots` is
  // the authoritative list of what this run wrote — compare treats a PNG on
  // disk that is not listed as a leftover from an earlier capture — while
  // `expected` is the full job set, so a shot that failed in both captures
  // surfaces as not-captured instead of vanishing from the report.
  const manifest = {
    platform: process.platform,
    arch: process.arch,
    chromium: browser.version(),
    expected: jobs.map((job) => shotFileName(job.storyId, job.colorScheme)).sort(),
    shots: shots.map((shot) => shot.file).sort(),
  };
  await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `Captured ${shots.length} shot(s) into ${outDir}` +
      (failures.length > 0 ? `; ${failures.length} failed` : '') +
      '\n',
  );
  if (failures.length > 0) process.exitCode = 1;
}

/*
 * Pixel comparison. PNG decode/encode goes through the same Chromium that
 * captured the shots — no second codec, no extra dependency. A pixel counts
 * as changed when any RGBA channel differs at all; there is no tolerance,
 * because a 1px move is exactly what this tool exists to catch.
 */
function diffImages() {
  // Runs inside the browser via page.evaluate; keep it free of outer refs.
  return async ({ beforeB64, afterB64 }) => {
    const decode = (b64) =>
      new Promise((resolvePromise, reject) => {
        const img = new Image();
        img.onload = () => resolvePromise(img);
        img.onerror = () => reject(new Error('PNG decode failed'));
        img.src = `data:image/png;base64,${b64}`;
      });
    const [before, after] = await Promise.all([decode(beforeB64), decode(afterB64)]);
    if (before.width !== after.width || before.height !== after.height) {
      return {
        sizeMismatch: true,
        beforeSize: [before.width, before.height],
        afterSize: [after.width, after.height],
      };
    }
    const { width, height } = before;
    const pixels = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, width, height).data;
    };
    const a = pixels(before);
    const b = pixels(after);
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = width;
    diffCanvas.height = height;
    const diffCtx = diffCanvas.getContext('2d');
    const diff = diffCtx.createImageData(width, height);
    let changed = 0;
    const box = { left: width, top: height, right: -1, bottom: -1 };
    for (let i = 0; i < a.length; i += 4) {
      const same =
        a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3];
      if (same) {
        // Dimmed grayscale of the after image: context without noise.
        const gray = Math.round(0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2]);
        const dim = 96 + Math.round(gray * 0.35);
        diff.data[i] = dim;
        diff.data[i + 1] = dim;
        diff.data[i + 2] = dim;
        diff.data[i + 3] = 255;
        continue;
      }
      changed += 1;
      const pixel = i / 4;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x < box.left) box.left = x;
      if (x > box.right) box.right = x;
      if (y < box.top) box.top = y;
      if (y > box.bottom) box.bottom = y;
      diff.data[i] = 255;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 255;
      diff.data[i + 3] = 255;
    }
    if (changed === 0) return { changed: 0, width, height };
    diffCtx.putImageData(diff, 0, 0);
    return {
      changed,
      width,
      height,
      box,
      diffPngB64: diffCanvas.toDataURL('image/png').slice('data:image/png;base64,'.length),
    };
  };
}

async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export async function listShots(dir) {
  try {
    // *.diff.png belongs to a --diff-dir report, not to the shot set; counting
    // it would read report artifacts as missing shots on the next compare.
    return (await readdir(dir)).filter(
      (name) => name.endsWith('.png') && !name.endsWith('.diff.png'),
    );
  } catch (error) {
    throw new Error(
      `Cannot read shots from ${dir}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Shot files on disk that the capture's manifest did not produce this run. */
export function staleShots(files, manifest) {
  if (!Array.isArray(manifest?.shots)) return [];
  return files.filter((file) => !manifest.shots.includes(file));
}

/*
 * Per-file disposition before any pixel work. Only `compare` rows count as
 * evidence; everything else lands in the skipped bucket and fails the run:
 *   missing-before / missing-after — on disk on one side only;
 *   stale — on disk but absent from that capture's manifest `shots`;
 *   not-captured — expected by a manifest but produced by neither capture.
 */
export function planShots(beforeFiles, afterFiles, beforeManifest, afterManifest) {
  const expected = new Set([
    ...(Array.isArray(beforeManifest?.expected) ? beforeManifest.expected : []),
    ...(Array.isArray(afterManifest?.expected) ? afterManifest.expected : []),
  ]);
  const stale = new Set([
    ...staleShots([...beforeFiles], beforeManifest),
    ...staleShots([...afterFiles], afterManifest),
  ]);
  const files = [...new Set([...beforeFiles, ...afterFiles, ...expected])].sort();
  return files.map((file) => {
    const inBefore = beforeFiles.has(file);
    const inAfter = afterFiles.has(file);
    let status = 'compare';
    if (!inBefore && !inAfter) status = 'not-captured';
    else if (stale.has(file)) status = 'stale';
    else if (!inBefore) status = 'missing-before';
    else if (!inAfter) status = 'missing-after';
    return { file, status };
  });
}

export async function runCompare(beforeArg, afterArg, options) {
  const beforeDir = resolve(beforeArg);
  const afterDir = resolve(afterArg);
  const diffDir = resolve(options['diff-dir'] ?? `${afterDir}-diff`);
  const [beforeManifest, afterManifest] = await Promise.all([
    readManifest(beforeDir),
    readManifest(afterDir),
  ]);
  for (const key of ['platform', 'arch', 'chromium']) {
    if (
      beforeManifest?.[key] &&
      afterManifest?.[key] &&
      beforeManifest[key] !== afterManifest[key]
    ) {
      process.stderr.write(
        `warning: captures disagree on ${key} (${beforeManifest[key]} vs ${afterManifest[key]}); ` +
          'font and raster differences will read as pixel diffs.\n',
      );
    }
  }
  const beforeFiles = new Set(await listShots(beforeDir));
  const afterFiles = new Set(await listShots(afterDir));
  const results = planShots(beforeFiles, afterFiles, beforeManifest, afterManifest);
  if (results.length === 0) {
    throw new Error(
      `No .png screenshots found in ${beforeDir} or ${afterDir} — nothing to compare.`,
    );
  }
  const toCompare = results.filter((row) => row.status === 'compare');
  if (toCompare.length > 0) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const differ = diffImages();
      for (const row of toCompare) {
        const [beforePng, afterPng] = await Promise.all([
          readFile(join(beforeDir, row.file)),
          readFile(join(afterDir, row.file)),
        ]);
        const result = await page.evaluate(differ, {
          beforeB64: beforePng.toString('base64'),
          afterB64: afterPng.toString('base64'),
        });
        if (result.sizeMismatch) {
          Object.assign(row, { status: 'size-mismatch', ...result });
          continue;
        }
        if (result.changed === 0) {
          Object.assign(row, { status: 'identical', width: result.width, height: result.height });
          continue;
        }
        const diffPath = join(diffDir, `${row.file}.diff.png`);
        await mkdir(diffDir, { recursive: true });
        await writeFile(diffPath, Buffer.from(result.diffPngB64, 'base64'));
        Object.assign(row, { status: 'changed', ...result, diffPngB64: undefined });
      }
    } finally {
      await browser.close();
    }
  }
  const changed = results.filter((row) => row.status === 'changed');
  const identical = results.filter((row) => row.status === 'identical');
  const skipped = results.filter((row) => row.status !== 'changed' && row.status !== 'identical');
  for (const row of identical) process.stdout.write(`= ${row.file}\n`);
  for (const row of changed) {
    const pct = ((row.changed / (row.width * row.height)) * 100).toFixed(3);
    process.stdout.write(
      `≠ ${row.file} — ${row.changed.toLocaleString()} px (${pct}%), ` +
        `box ${row.box.right - row.box.left + 1}×${row.box.bottom - row.box.top + 1} ` +
        `at (${row.box.left},${row.box.top})\n`,
    );
  }
  for (const row of skipped) process.stdout.write(`! ${row.file} — ${row.status}\n`);
  process.stdout.write(
    `${changed.length} changed, ${identical.length} identical, ${skipped.length} skipped.\n` +
      (changed.length > 0 ? `Diffs: ${diffDir}\n` : ''),
  );
  if (changed.length > 0 || skipped.length > 0) process.exitCode = 1;
}

function listOption(value) {
  if (value === undefined) return null;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing --${name}. See --help.`);
  }
  return value;
}

export function parseCliArgs(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      i += 1;
    } else {
      options[name] = true;
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), options };
}

const USAGE = `Usage:
  node scripts/storybook-visual-diff.mjs capture --out DIR [options]
  node scripts/storybook-visual-diff.mjs compare BEFORE_DIR AFTER_DIR [--diff-dir DIR]

capture options:
  --out DIR          where PNG shots and manifest.json go (required)
  --storybook DIR    built catalog to serve (default: ${DEFAULT_STORYBOOK_DIR})
  --stories a,b      substring filter on story ids (default: the #5794 set)
  --schemes a,b      color schemes (default: light,dark)

compare options:
  --diff-dir DIR     where *.diff.png images go (default: <AFTER_DIR>-diff)

Example:
  npm --workspace @maka/desktop run build-storybook
  node scripts/storybook-visual-diff.mjs capture --out /tmp/maka-shots/before
  node scripts/storybook-visual-diff.mjs compare /tmp/maka-shots/before /tmp/maka-shots/after
`;

async function runCli(argv) {
  const { command, positionals, options } = parseCliArgs(argv);
  if (options.help || command === 'help' || command === undefined) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'capture') {
    await runCapture(options);
    return;
  }
  if (command === 'compare') {
    const [before, after] = positionals;
    if (!before || !after) throw new Error('compare needs BEFORE_DIR and AFTER_DIR. See --help.');
    await runCompare(before, after, options);
    return;
  }
  throw new Error(`Unknown command: ${command}. See --help.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
