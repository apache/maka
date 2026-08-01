import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('startup onboarding loading slot paints visible skeleton chrome', () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const css = readFileSync(join(desktopRoot, 'src', 'renderer', 'styles', 'onboarding.css'), 'utf8');
  const block = css.match(/\.maka-onboarding-loading\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(block, /background:\s*var\(--foreground-5\)/);
  assert.match(block, /border:\s*var\(--border-width-hairline\) solid var\(--border-strong\)/);
  assert.match(block, /box-shadow:/);
  assert.match(css, /var\(--foreground-8\)/);
  assert.match(css, /\.maka-onboarding-loading::before\s*\{/);
  assert.match(css, /\.maka-onboarding-loading::after\s*\{/);
});

test('index.html paints an inline preload skeleton before React mounts', () => {
  const cwd = process.cwd();
  const desktopRoot = cwd.endsWith(join('apps', 'desktop')) ? cwd : join(cwd, 'apps', 'desktop');
  const html = readFileSync(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');

  // #root ships a non-empty, accessible skeleton so there is no blank window
  // during the CSS + JS loading gap; createRoot() replaces it on mount.
  assert.match(html, /<div id="root">\s*<div class="maka-preload"/);
  assert.match(html, /aria-busy="true"/);
  // Styled inline (before external CSS) with hardcoded colors, since
  // maka-tokens.css has not loaded yet — no CSS variables in the skeleton.
  assert.match(html, /\.maka-preload\s*\{[\s\S]*?background:\s*#[0-9a-fA-F]{3,6}/);
  assert.doesNotMatch(html.match(/\.maka-preload\s*\{[\s\S]*?\}/)?.[0] ?? '', /var\(/);
  // Dark mode handled to match cached-theme-bootstrap fallback.
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
});

test('the renderer-facing core barrel does not evaluate Node-only runtime boundary code', () => {
  const cwd = process.cwd();
  const repoRoot = cwd.endsWith(join('apps', 'desktop')) ? join(cwd, '..', '..') : cwd;
  const coreBarrel = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'index.ts'), 'utf8');
  const runtimeBoundary = readFileSync(
    join(repoRoot, 'packages', 'core', 'src', 'runtime-boundary.ts'),
    'utf8',
  );

  assert.match(runtimeBoundary, /from 'node:crypto'/);
  assert.doesNotMatch(coreBarrel, /export\s*\{[^;]*\}\s*from '\.\/runtime-boundary\.js'/);
  assert.match(coreBarrel, /export type\s*\{[^;]*\}\s*from '\.\/runtime-boundary\.js'/);
});
