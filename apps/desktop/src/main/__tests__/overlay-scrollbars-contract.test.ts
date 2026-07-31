import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

function repoFile(path: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

async function readWorkspaceSources(dir: string): Promise<Array<[string, string]>> {
  const root = resolve(REPO_ROOT, dir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const sources: Array<[string, string]> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const abs = resolve(entry.parentPath, entry.name);
    sources.push([abs.slice(root.length + 1), await readFile(abs, 'utf8')]);
  }
  return sources;
}

describe('OverlayScrollbars integration contract', () => {
  it('keeps KingSora OverlayScrollbars as a shared UI dependency', async () => {
    const uiPackage = JSON.parse(await repoFile('packages/ui/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const desktopPackage = JSON.parse(await repoFile('apps/desktop/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = await repoFile('package-lock.json');

    assert.ok(
      uiPackage.dependencies?.overlayscrollbars,
      '@maka/ui must own overlayscrollbars because it exports the scroll primitive',
    );
    assert.equal(
      desktopPackage.dependencies?.overlayscrollbars,
      undefined,
      '@maka/desktop should consume the @maka/ui primitive instead of owning a second direct dependency',
    );
    assert.match(lockfile, /"node_modules\/overlayscrollbars"/, 'lockfile must include the installed OverlayScrollbars package');
  });

  it('wraps the vendor library in a viewport-ref preserving React primitive', async () => {
    const src = await repoFile('packages/ui/src/overlay-scroll-area.tsx');

    assert.match(src, /from 'overlayscrollbars'/, 'OverlayScrollArea must import the real OverlayScrollbars package');
    assert.match(src, /theme:\s*'os-theme-maka'/, 'OverlayScrollArea must use the Maka scrollbar theme');
    assert.match(src, /autoHide:\s*'move'/, 'OverlayScrollArea should use target-layout like overlay scrollbars that appear on pointer motion');
    assert.match(src, /useImperativeHandle\(forwardedRef,[\s\S]*viewportRef\.current/, 'forwarded refs must point at the viewport for scrollTop/onScroll callers');
    assert.match(src, /elements:\s*\{[\s\S]*viewport,[\s\S]*content,[\s\S]*\}/, 'OverlayScrollbars must mount with explicit viewport/content elements');
  });

  it('keeps Base UI ScrollArea banned across both workspaces', async () => {
    // Simplification Round A follow-up: the orphaned primitives/scroll-area.tsx
    // wrapper (zero consumers, never exported from the ui index) is deleted;
    // the invariant it carried — nothing reintroduces Base UI scrollbars —
    // now holds repo-wide instead of for one file.
    const uiSources = await readWorkspaceSources('packages/ui/src');
    const desktopSources = await readWorkspaceSources('apps/desktop/src');

    for (const [file, src] of [...uiSources, ...desktopSources]) {
      assert.doesNotMatch(
        src,
        /@base-ui\/react\/scroll-area/,
        `${file} must not reintroduce Base UI ScrollArea — all scroll surfaces go through OverlayScrollArea`,
      );
    }
  });

  it('loads vendor CSS and defines the Maka theme tokens', async () => {
    const styles = await readRendererContractCss();
    const tokens = await repoFile('apps/desktop/src/renderer/maka-tokens.css');

    assert.match(styles, /@import "overlayscrollbars\/overlayscrollbars\.css" layer\(maka\.legacy\);/, 'renderer CSS must load OverlayScrollbars vendor styles');
    assert.match(styles, /\.os-theme-maka\s*\{[\s\S]*--os-size:\s*8px/, 'Maka theme must define compact 8px overlay scrollbars');
    assert.match(styles, /\.os-theme-maka\s*\{[\s\S]*--os-handle-bg:\s*var\(--border\)/, 'Maka theme must bind the handle to existing design tokens');
    assert.match(tokens, /Native fallback[\s\S]*OverlayScrollbars/, 'native scrollbar rules must be documented as fallback, not the primary app scroller');
  });

  it('migrates the primary app scroll surfaces onto OverlayScrollArea', async () => {
    const components = await repoFile('packages/ui/src/chat-view.tsx');
    const sessionListMarkup = renderSessionListPanel();
    const settings = await readSettingsCombinedSource();

    assert.match(sessionListMarkup, /<div[^>]*class="maka-overlay-scrollarea maka-list-stack"[^>]*data-overlayscrollbars="host"/, 'sidebar session list must render through OverlayScrollArea');
    assert.match(sessionListMarkup, /class="maka-overlay-scrollarea-content maka-list-stackContent"/, 'sidebar session list must keep its OverlayScrollArea content layout class');
    assert.match(components, /<OverlayScrollArea[\s\S]*ref=\{scrollRef\}[\s\S]*className="maka-chat messages"[\s\S]*onScroll=\{onScroll\}/, 'active chat message list must keep its onScroll viewport handler on OverlayScrollArea');
    assert.match(settings, /OverlayScrollArea/, 'Settings content pane must use OverlayScrollArea');
    assert.match(settings, /<OverlayScrollArea[\s\S]*className="settingsPageContent"[\s\S]*contentClassName="settingsPageContentInner"/, 'Settings content pane must preserve its layout classes through OverlayScrollArea');
  });
});
