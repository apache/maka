/**
 * Icon library seam contract.
 *
 * Business code imports named icons from `@maka/ui/icons`; the seam is
 * allowed to pick the underlying library. Generic UI icons come from
 * `lucide-react`; bot/channel brand icons render as local SVG React
 * components without Iconify runtime code.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const ICONS_FILE = resolve(REPO_ROOT, 'packages/ui/src/icons.tsx');

async function walkSrc(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkSrc(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function allSrcFiles(): Promise<string[]> {
  const dirs = [
    resolve(REPO_ROOT, 'packages/ui/src'),
    resolve(REPO_ROOT, 'apps/desktop/src'),
  ];
  const out: string[] = [];
  for (const dir of dirs) out.push(...(await walkSrc(dir)));
  return out;
}

async function walkDist(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkDist(full)));
    } else if (entry.isFile() && /\.js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('icon library seam contract', () => {
  it('renders generic UI icons through lucide-react at the @maka/ui/icons seam', async () => {
    const source = await readFile(ICONS_FILE, 'utf8');

    assert.match(source, /from ['"]lucide-react['"]/, 'icons.tsx must import/re-export lucide-react icons');
    assert.doesNotMatch(source, /makeIcon\(/, 'icons.tsx must not keep the old Phosphor mapping wrapper');
    assert.doesNotMatch(source, /['"]@iconify-json\/ph['"]/, 'Phosphor Iconify data must not remain in the generic icon seam');
    assert.doesNotMatch(source, /ph:[a-z0-9-]+/, 'generic icon exports must not point at Phosphor ids');
  });

  it('lucide-react is imported ONLY from packages/ui/src/icons.tsx', async () => {
    const files = await allSrcFiles();
    const offenders: string[] = [];
    for (const file of files) {
      if (file === ICONS_FILE) continue;
      const src = await readFile(file, 'utf8');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/['"]lucide-react['"]/.test(stripped)) {
        offenders.push(file.replace(REPO_ROOT + '/', ''));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Only packages/ui/src/icons.tsx may import lucide-react. Use @maka/ui/icons named exports instead:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('packages/ui/dist/icons.js is built from the Lucide seam (compiled output sweep)', async () => {
    const distRoot = resolve(REPO_ROOT, 'packages/ui/dist');
    const files = await walkDist(distRoot);
    const stale: string[] = [];
    const iconDist = files.find((file) => file.endsWith('/icons.js'));

    assert.ok(iconDist, 'packages/ui/dist/icons.js must exist after @maka/ui build');

    for (const file of files) {
      const src = await readFile(file, 'utf8');
      if (/['"]@iconify-json\/ph['"]/.test(src) || /ph:[a-z0-9-]+/.test(src) || /makeIcon\(/.test(src)) {
        stale.push(file.replace(REPO_ROOT + '/', ''));
      }
    }
    const iconSource = await readFile(iconDist, 'utf8');

    assert.match(iconSource, /from ['"]lucide-react['"]/, 'compiled icons.js must import/re-export lucide-react');
    assert.deepEqual(
      stale,
      [],
      `Stale @maka/ui dist still contains Phosphor/Iconify mapping output. Rebuild from current source:\n  ${stale.join('\n  ')}`,
    );
  });

  it('does not import Iconify packages anywhere in source', async () => {
    const files = await allSrcFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/['"]@iconify\/react['"]/.test(stripped) || /['"]@iconify-json\//.test(stripped)) {
        offenders.push(file.replace(REPO_ROOT + '/', ''));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Iconify runtime packages are not needed: generic icons use lucide-react and bot brands use local SVG components:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('renders every bot provider with a local SVG logo component', async () => {
    const source = await readFile(ICONS_FILE, 'utf8');
    const botBrand = await readFile(resolve(REPO_ROOT, 'packages/ui/src/bot-brand.ts'), 'utf8');
    const ui = await import(resolve(REPO_ROOT, 'packages/ui/dist/index.js'));
    const providers = ['telegram', 'feishu', 'wecom', 'wechat', 'discord', 'dingtalk', 'qq', 'slack', 'whatsapp'] as const;

    assert.equal(typeof ui.BotBrandLogo, 'function', '@maka/ui must expose a provider-based bot brand logo component');
    assert.doesNotMatch(source, /BotBrandIcon/, 'the icon seam must not expose a generic bot icon registry API');
    assert.doesNotMatch(source, /IconifyIcon/, 'icons.tsx must not keep the old IconifyIcon API');
    assert.doesNotMatch(botBrand, /iconifyId/, 'bot brand metadata must not keep Iconify naming');
    assert.doesNotMatch(botBrand, /iconId/, 'bot brand metadata should not leak local icon registry ids to callers');

    for (const provider of providers) {
      const brand = ui.BOT_BRAND[provider];
      const html = renderToStaticMarkup(createElement(ui.BotBrandLogo, { provider, width: 24, height: 24, 'aria-hidden': true }));
      assert.match(html, /<svg\b/, `${provider} must render a local SVG logo`);
      assert.match(html, new RegExp(`data-provider="${provider}"`), `${provider} logo should identify its provider for debugging and snapshots`);
      assert.doesNotMatch(html, new RegExp(`>${brand.glyph}<`), `${provider} must not fall back to its glyph placeholder`);
    }
  });

  it('package manifests do not depend on Iconify icon runtimes', async () => {
    const manifests = [
      'package-lock.json',
      'packages/ui/package.json',
      'apps/desktop/package.json',
    ];
    const offenders: string[] = [];
    for (const manifest of manifests) {
      const src = await readFile(resolve(REPO_ROOT, manifest), 'utf8');
      if (/@iconify\/(?:react)|@iconify-json\//.test(src)) {
        offenders.push(manifest);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Iconify packages must not remain in manifests after local bot SVG rendering:\n  ${offenders.join('\n  ')}`,
    );
  });
});
