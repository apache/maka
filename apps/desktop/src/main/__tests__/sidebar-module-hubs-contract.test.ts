import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = resolve(process.cwd(), '..', '..');

async function readSource(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), 'utf8');
}

describe('sidebar module hubs contract', () => {
  it('renders Extensions as one destination that restores its remembered module', async () => {
    const source = await readSource('packages/ui/src/session-sidebar-nav.tsx');

    assert.match(
      source,
      /props\.onSelect\(\{ section: 'extensions', module: moduleMemory\.extensions \}\)/,
    );
    assert.doesNotMatch(source, /aria-expanded=|maka-sidebar-nav-tree|moduleNavLabel\.skills|moduleNavLabel\.mcp/);
  });

  it('projects both hubs through one localized title switch without parallel legacy pages', async () => {
    const shell = await readSource('apps/desktop/src/renderer/app-shell.tsx');

    assert.match(shell, /<ModuleHubSelector[\s\S]*hub="extensions"[\s\S]*hub="automations"/);
    assert.match(shell, /<SkillsPage[\s\S]*hubHeader=\{extensionsHubHeader\}/);
    assert.match(shell, /<McpPage hubHeader=\{extensionsHubHeader\}/);
    assert.match(shell, /<AutomationsPage[\s\S]*hubHeader=\{automationsHubHeader\}/);
    assert.match(shell, /<DailyReviewPage[\s\S]*hubHeader=\{automationsHubHeader\}/);
    assert.doesNotMatch(shell, /navSelection\.section === '(?:skills|mcp|daily-review)'/);
  });

  it('keeps conversation grouping and history visible on module pages', async () => {
    const source = await readSource('packages/ui/src/session-list-panel.tsx');

    assert.match(source, /\{onViewModeChange\s*&&\s*\(/);
    assert.match(source, /<SessionHistoryList/);
    assert.doesNotMatch(source, /showSessionNavigation|data-content=/);
  });
});
