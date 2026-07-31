import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../../../..');

test('MCP market ships the requested first-party catalog and cancellable install affordance', async () => {
  const [catalog, page, styles, preload] = await Promise.all([
    readFile(resolve(repoRoot, 'apps/desktop/src/renderer/mcp-catalog.ts'), 'utf8'),
    readFile(resolve(repoRoot, 'apps/desktop/src/renderer/mcp-page.tsx'), 'utf8'),
    readFile(resolve(repoRoot, 'apps/desktop/src/renderer/styles/module-pages/mcp.css'), 'utf8'),
    readFile(resolve(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8'),
  ]);

  for (const id of [
    'dingtalk', 'feishu', 'slack', 'line', 'notion', 'macos-apps',
    'google-calendar', 'figma', 'vercel', 'supabase',
  ]) {
    assert.match(catalog, new RegExp(`id: ['"]${id}['"]`), `${id} must be present in the MCP market`);
  }

  for (const packageSpec of [
    'dingtalk-mcp@1.1.21',
    '@larksuiteoapi/lark-mcp@0.5.1',
    '@modelcontextprotocol/server-slack@2025.4.25',
    '@line/line-bot-mcp-server@0.5.0',
    'mcp-server-apple-events@1.4.0',
    '@cocal/google-calendar-mcp@2.6.2',
    'figma-developer-mcp@0.13.2',
  ]) {
    assert.ok(catalog.includes(packageSpec), `${packageSpec} must stay pinned in the bundled catalog`);
  }
  assert.doesNotMatch(catalog, /YOUR_APP_(?:ID|SECRET)/, 'Feishu credentials must not be placed in process args');
  assert.match(catalog, /env: \{ APP_ID: '', APP_SECRET: '' \}/);

  assert.match(page, /data-phase=\{props\.phase \?\? 'idle'\}/);
  assert.match(page, /onClick=\{installing \? props\.onCancel : props\.onInstall\}/);
  assert.match(
    page,
    /<div className="maka-mcp-search">\s*<TextInput[\s\S]*width="100%"/,
    'MCP search geometry must live on a wrapper around the Astryx field',
  );
  assert.doesNotMatch(
    styles,
    /\.maka-mcp-search\s*\{[^}]*(?:height|min-height|border|box-shadow):/,
    'module CSS must not restyle Astryx search-field chrome',
  );
  assert.match(styles, /data-phase="installing"[^}]*:hover \.maka-mcp-install-spinner/s);
  assert.match(styles, /\.maka-mcp-install-cancel/);
  assert.match(preload, /cancelInstall\(serverId: string\)/);
});
