/**
 * Drives the real coverage gate (disk path set vs inventory artifacts).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

describe('astryx surface file inventory coverage', () => {
  it('passes the coverage gate against on-disk product trees', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/check-astryx-surface-inventory.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /astryx surface inventory coverage: ok/);
  });

  it('lists every settings page/modal as its own markdown row', () => {
    const md = readFileSync(join(root, 'docs/astryx-surface-file-inventory.md'), 'utf8');
    const required = [
      'apps/desktop/src/renderer/settings/general-settings-page.tsx',
      'apps/desktop/src/renderer/settings/appearance-settings-page.tsx',
      'apps/desktop/src/renderer/settings/settings-modal.tsx',
      'apps/desktop/src/renderer/mcp-page.tsx',
      'packages/ui/src/skills-panel.tsx',
      'packages/ui/src/plan-reminder-panel.tsx',
      'packages/ui/src/daily-review-panel.tsx',
      'packages/ui/src/primitives/module-page.tsx',
    ];
    for (const path of required) {
      assert.match(md, new RegExp(`\`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
    }
    // No family-batch collapse of settings pages
    assert.doesNotMatch(
      md,
      /General, Appearance, Data, Providers, Bot, Memory.*already aligned/,
    );
  });

  it('paths file line count matches markdown file rows for inventoried files', () => {
    const paths = readFileSync(join(root, 'docs/astryx-surface-file-inventory.paths'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    const md = readFileSync(join(root, 'docs/astryx-surface-file-inventory.md'), 'utf8');
    const filesSection = md.split('## Files')[1] ?? '';
    const rowCount = [...filesSection.matchAll(/^\| `[^`]+` \|/gm)].length;
    assert.equal(rowCount, paths.length, `md rows ${rowCount} vs paths ${paths.length}`);
  });

  it('does not claim Astryx usage from comment-only name matches', () => {
    const md = readFileSync(join(root, 'docs/astryx-surface-file-inventory.md'), 'utf8');
    // These files historically false-positive'd when the analyzer scanned comments.
    const commentOnly = [
      'packages/ui/src/icons.tsx',
      'apps/desktop/src/renderer/live-turn-reconciler.tsx',
      'apps/desktop/src/renderer/settings/settings-rows.tsx',
      'packages/ui/src/primitives/chat.tsx',
      'packages/ui/src/primitives/page-header.tsx',
      'apps/desktop/src/renderer/settings/settings-metric-card.tsx',
    ];
    for (const path of commentOnly) {
      const line = md.split('\n').find((l) => l.includes(`\`${path}\``));
      assert.ok(line, `missing inventory row for ${path}`);
      // Table columns: Path | Role | Astryx used | Gap | Severity
      const cols = line.split('|').map((c) => c.trim());
      // cols[0] empty, [1]=path, [2]=role, [3]=astryx, [4]=gap, [5]=severity
      assert.equal(cols[3], 'none', `${path} Astryx used must be none, got: ${cols[3]}`);
      assert.doesNotMatch(cols[4] ?? '', /uses Astryx/);
    }
  });
});


