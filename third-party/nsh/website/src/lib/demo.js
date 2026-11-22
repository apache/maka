import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHighlighter } from 'shiki';
import { themes } from './markdown.js';

// Demos are small nsh apps in `website/demos/<name>.tsx`. A page names one in
// its frontmatter (`demo: counter`); the site shows it running in a phone
// frame, through the web player in `public/play/`, next to its source. Until
// the player is built, pages show the source alone (decided at build time).

const ROOT = process.cwd();
const DEMOS = join(ROOT, 'demos');
const PLAYER = join(ROOT, 'public', 'play', 'index.html');

/** The app's logical size: an iPhone's 390×844 points. */
export const SCREEN = { width: 390, height: 844 };

/**
 * The layouts a demo panel switches between: a phone (touch, the phone
 * idiom) and a desktop window (a pointer, the desktop idiom). Every demo
 * works in both (README "Demos").
 */
export const LAYOUTS = {
  mobile: { ...SCREEN, idiom: 'phone' },
  desktop: { width: 1024, height: 640, idiom: 'desktop' },
};

export function demoFile(name) {
  return join(DEMOS, `${name}.tsx`);
}

export function demoSource(name) {
  try {
    return readFileSync(demoFile(name), 'utf8').replace(/\s+$/, '');
  } catch {
    return null;
  }
}

export function hasPlayer() {
  return existsSync(PLAYER);
}

/**
 * Changes when a demo source or the player's presence changes. It goes into the
 * markdown options, so Astro's content cache (keyed by the config) re-renders
 * pages instead of keeping a placeholder after the player is added.
 */
export function demoState() {
  const hash = createHash('sha1');
  hash.update(String(hasPlayer()));
  // The markup itself, so editing this file re-renders the pages too.
  hash.update(readFileSync(new URL(import.meta.url), 'utf8'));
  try {
    for (const name of readdirSync(DEMOS).sort()) {
      if (name.endsWith('.tsx')) hash.update(`${name}:${statSync(join(DEMOS, name)).mtimeMs}`);
    }
  } catch {}
  return hash.digest('hex').slice(0, 12);
}

let highlighter;

export async function highlight(code, lang = 'tsx') {
  highlighter ??= createHighlighter({ themes: [themes.light, themes.dark], langs: ['tsx', 'sh'] });
  const html = (await highlighter).codeToHtml(code, {
    lang,
    themes: { light: themes.light.name, dark: themes.dark.name },
    defaultColor: 'light',
  });
  // The same class Astro gives fenced blocks, so the same token rules apply.
  return html.replace('<pre class="shiki', '<pre class="astro-code shiki');
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COPY = {
  en: {
    preview: 'Preview',
    source: 'Source',
    open: 'Open in new tab',
    edit: 'Edit in Playground',
    frame: (name) => `Live demo: ${name}`,
    pending: 'The live preview is not built yet.',
    runLocally: 'Run it on a simulator or device:',
    missing: (name) => `Demo “${name}” was not found in website/demos.`,
    label: 'Demo',
    live: 'Live',
    layout: 'Layout',
    mobile: 'Mobile',
    desktop: 'Desktop',
  },
  'zh-CN': {
    preview: '预览',
    source: '源码',
    open: '在新标签页打开',
    edit: '在线编辑',
    frame: (name) => `在线示例：${name}`,
    pending: '在线预览尚未构建。',
    runLocally: '在模拟器或真机上运行：',
    missing: (name) => `website/demos 中没有名为“${name}”的示例。`,
    label: '示例',
    live: '运行中',
    layout: '布局',
    mobile: '手机',
    desktop: '桌面',
  },
};

export function playerHref(name, base = '/', layout = 'mobile') {
  return `${base}play/index.html?theme=dark&idiom=${LAYOUTS[layout].idiom}#${encodeURIComponent(name)}`;
}

/**
 * The frame a demo runs in: a card of the site's design (no device chrome)
 * with a slim bar (an icon tile, the title, a badge) above the app's inset
 * surface. Shared with the playground.
 */
export function frameBar(title, badge) {
  return `<div class="phone__bar"><span class="phone__tile" aria-hidden="true"><svg viewBox="14 12 100 100" width="12" height="12"><path d="M30 100 V58 a34 34 0 0 1 68 0 V100" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round"/></svg></span><span class="phone__title">${escape(title)}</span>${badge ? `<span class="phone__badge"><i aria-hidden="true"></i>${escape(badge)}</span>` : ''}</div>`;
}

/**
 * A frame at phone width: the app renders at 390×844 points, scaled to fit
 * (`--phone-scale`), with the demo running inside, or a placeholder screen
 * when there is no player.
 */
export function phoneHtml(name, { base = '/', lang = 'en', eager = false, layout = 'mobile' } = {}) {
  const t = COPY[lang] ?? COPY.en;
  const size = LAYOUTS[layout];
  const screen = hasPlayer()
    ? `<iframe allow="clipboard-write" data-player-src="${escape(playerHref(name, base, layout))}" title="${escape(t.frame(name))}" loading="${eager ? 'eager' : 'lazy'}" width="${size.width}" height="${size.height}"></iframe>`
    : `<div class="phone__placeholder">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>
        <p class="phone__placeholder-title">${escape(t.pending)}</p>
        <p>${escape(t.runLocally)}</p>
        <code>nsh run website/demos/${escape(name)}.tsx</code>
      </div>`;
  const bar = frameBar(`${name}.tsx`, hasPlayer() ? t.live : '');
  return `<div class="phone" data-layout="${layout}" style="--phone-w:${size.width};--phone-h:${size.height}">${bar}<div class="phone__screen">${screen}</div></div>`;
}

/** The demo block of a documentation page: phone and source behind a segmented control. */
export async function demoPanelHtml(name, { base = '/', lang = 'en' } = {}) {
  const t = COPY[lang] ?? COPY.en;
  const source = demoSource(name);
  if (source === null) {
    return `<div class="demo demo--missing" role="note">${escape(t.missing(name))}</div>`;
  }
  const code = await highlight(source);
  const file = `${name}.tsx`;
  const id = `demo-${name.replace(/[^a-z0-9_-]/gi, '-')}`;

  if (!hasPlayer()) {
    return `<figure class="demo demo--source-only" data-demo="${escape(name)}" data-pagefind-ignore>
      <figcaption class="demo__bar">
        <span class="demo__label">${escape(t.label)}</span>
        <span class="demo__file">${escape(file)}</span>
      </figcaption>
      <div class="demo__code">${code}</div>
    </figure>`;
  }

  return `<figure class="demo" data-demo="${escape(name)}" data-view="preview" data-layout="mobile" data-pagefind-ignore>
    <figcaption class="demo__bar">
      <div class="demo__views" data-slot="tabs-list" data-size="xs" role="tablist" aria-label="${escape(t.label)}">
        <button type="button" data-slot="tabs-trigger" role="tab" id="${id}-tab-preview" aria-controls="${id}-preview" aria-selected="true" data-demo-view="preview">${escape(t.preview)}</button>
        <button type="button" data-slot="tabs-trigger" role="tab" id="${id}-tab-source" aria-controls="${id}-source" aria-selected="false" tabindex="-1" data-demo-view="source">${escape(t.source)}</button>
      </div>
      <div class="demo__layouts" data-slot="toggle-group" data-variant="segmented" data-size="xs" role="radiogroup" aria-label="${escape(t.layout)}">
        <button type="button" data-slot="toggle-group-item" role="radio" aria-checked="true" data-demo-layout="mobile">${escape(t.mobile)}</button>
        <button type="button" data-slot="toggle-group-item" role="radio" aria-checked="false" tabindex="-1" data-demo-layout="desktop">${escape(t.desktop)}</button>
      </div>
      <span class="demo__file">${escape(file)}</span>
      <div class="demo__actions" data-slot="button-group" role="group">
        <a data-slot="button" data-variant="outline" data-size="icon-xs" href="${escape(`${base}${lang === 'zh-CN' ? 'zh-CN/' : ''}playground#demo=${encodeURIComponent(name)}`)}" title="${escape(t.edit)}" aria-label="${escape(t.edit)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></a>
        <a data-slot="button" data-variant="outline" data-size="icon-xs" href="${escape(playerHref(name, base))}" target="_blank" rel="noopener" title="${escape(t.open)}" aria-label="${escape(t.open)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
      </div>
    </figcaption>
    <div class="demo__body">
    <div class="demo__stage" id="${id}-preview" role="tabpanel" aria-labelledby="${id}-tab-preview" data-active>${phoneHtml(name, { base, lang })}</div>
    <div class="demo__code" id="${id}-source" role="tabpanel" aria-labelledby="${id}-tab-source">${code}</div>
    </div>
  </figure>`;
}
