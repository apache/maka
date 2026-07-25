import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { getSettingsSharedCopy } from '../../renderer/locales/settings-shared-copy.js';

import {
  findInlineCjkLiterals,
  findSilentCatalogFallbacks,
  formatSourceViolations,
  type LiteralExemption,
} from './localized-source-contract-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

export const PR2_TARGET_PRESENTATION_FILES = [
  'apps/desktop/src/renderer/OnboardingHero.tsx',
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
  'apps/desktop/src/renderer/app-shell-chat-actions.ts',
  'apps/desktop/src/renderer/app-shell-command-actions.ts',
  'apps/desktop/src/renderer/app-shell-copy.ts',
  'apps/desktop/src/renderer/app-shell-daily-review-actions.ts',
  'apps/desktop/src/renderer/app-shell-open-skill-action.ts',
  'apps/desktop/src/renderer/app-shell-project-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-start-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-row-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-settings-actions.ts',
  'apps/desktop/src/renderer/app-shell-skill-actions.ts',
  'apps/desktop/src/renderer/app-shell.tsx',
  'apps/desktop/src/renderer/command-palette-commands.ts',
  'apps/desktop/src/renderer/command-palette.tsx',
  'apps/desktop/src/renderer/connection-status.ts',
  'apps/desktop/src/renderer/error-boundary.tsx',
  'apps/desktop/src/renderer/keyboard-help.tsx',
  'apps/desktop/src/renderer/onboarding-hero-copy.ts',
  'apps/desktop/src/renderer/open-path.ts',
  'apps/desktop/src/renderer/session-workspace-errors.ts',
  'apps/desktop/src/renderer/settings/SettingsModal.tsx',
  'apps/desktop/src/renderer/settings/about-settings-page.tsx',
  'apps/desktop/src/renderer/settings/appearance-settings-page.tsx',
  'apps/desktop/src/renderer/settings/general-settings-page.tsx',
  'apps/desktop/src/renderer/settings/nav-group-summary.ts',
  'apps/desktop/src/renderer/settings/settings-error-copy.ts',
  'apps/desktop/src/renderer/settings/settings-nav.ts',
  'apps/desktop/src/renderer/settings/settings-skeleton.tsx',
  'apps/desktop/src/renderer/settings/settings-surface.tsx',
  'apps/desktop/src/renderer/settings/password-input.tsx',
  'apps/desktop/src/renderer/use-shell-memory-pill.ts',
  'packages/ui/src/primitives/dialog-header.tsx',
  'apps/desktop/src/renderer/use-onboarding-snapshot.ts',
  'packages/ui/src/search-modal.tsx',
  'packages/ui/src/session-sidebar-nav.tsx',
] as const;

export const PR2_PRESENTATION_FILES = [
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
  'apps/desktop/src/renderer/app-shell-chat-actions.ts',
  'apps/desktop/src/renderer/app-shell-command-actions.ts',
  'apps/desktop/src/renderer/app-shell-copy.ts',
  'apps/desktop/src/renderer/app-shell-daily-review-actions.ts',
  'apps/desktop/src/renderer/app-shell-open-skill-action.ts',
  'apps/desktop/src/renderer/app-shell-project-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-start-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-row-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-settings-actions.ts',
  'apps/desktop/src/renderer/app-shell-skill-actions.ts',
  'apps/desktop/src/renderer/app-shell.tsx',
  'apps/desktop/src/renderer/command-palette-commands.ts',
  'apps/desktop/src/renderer/command-palette.tsx',
  'apps/desktop/src/renderer/connection-status.ts',
  'apps/desktop/src/renderer/error-boundary.tsx',
  'apps/desktop/src/renderer/keyboard-help.tsx',
  'apps/desktop/src/renderer/OnboardingHero.tsx',
  'apps/desktop/src/renderer/onboarding-hero-copy.ts',
  'apps/desktop/src/renderer/open-path.ts',
  'apps/desktop/src/renderer/session-workspace-errors.ts',
  'apps/desktop/src/renderer/use-onboarding-snapshot.ts',
  'apps/desktop/src/renderer/settings/SettingsModal.tsx',
  'apps/desktop/src/renderer/settings/about-settings-page.tsx',
  'apps/desktop/src/renderer/settings/appearance-settings-page.tsx',
  'apps/desktop/src/renderer/settings/general-settings-page.tsx',
  'apps/desktop/src/renderer/settings/nav-group-summary.ts',
  'apps/desktop/src/renderer/settings/settings-error-copy.ts',
  'apps/desktop/src/renderer/settings/settings-nav.ts',
  'apps/desktop/src/renderer/settings/settings-skeleton.tsx',
  'apps/desktop/src/renderer/settings/settings-surface.tsx',
  'apps/desktop/src/renderer/settings/password-input.tsx',
  'apps/desktop/src/renderer/use-shell-memory-pill.ts',
  'packages/ui/src/primitives/dialog-header.tsx',
  'packages/ui/src/search-modal.tsx',
  'packages/ui/src/session-sidebar-nav.tsx',
] as const;

const PR2_CATALOG_FILES = [
  'apps/desktop/src/renderer/locales/settings-shared-copy.ts',
  'apps/desktop/src/renderer/locales/settings-navigation-copy.ts',
  'apps/desktop/src/renderer/locales/settings-preferences-copy.ts',
  'apps/desktop/src/renderer/locales/connection-status-copy.ts',
  'apps/desktop/src/renderer/locales/onboarding-copy.ts',
  'apps/desktop/src/renderer/locales/shell-copy.ts',
  'packages/ui/src/shell-controls-copy.ts',
] as const;
const PR2_LITERAL_EXEMPTIONS: readonly LiteralExemption[] = [];

function repoSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('localized source contract helpers', () => {
  it('reports inline JSX Chinese but ignores comments and English literals', () => {
    const source = `
      // 中文说明不是用户可见文案
      export function Example() {
        const label = 'English';
        return <button aria-label="保存">保存</button>;
      }
    `;
    const violations = findInlineCjkLiterals(source, 'fixture.tsx');

    assert.deepEqual(
      violations.map((entry) => entry.text),
      ['保存', '保存'],
    );
  });

  it('reports Chinese template chunks around dynamic values', () => {
    const violations = findInlineCjkLiterals('export const label = `使用 ${skillName} 技能`; ', 'fixture.ts');

    assert.deepEqual(
      violations.map((entry) => entry.text),
      ['使用', '技能'],
    );
  });

  it('allows Chinese inside an explicitly identified catalog module', () => {
    assert.deepEqual(
      findInlineCjkLiterals(`export const copy = { zh: { save: '保存' }, en: { save: 'Save' } };`, 'catalog.ts', {
        allowCatalogCopy: true,
      }),
      [],
    );
  });

  it('requires an exact, reasoned exemption for protocol markers', () => {
    const exemption: LiteralExemption = {
      file: 'fixture.ts',
      text: '协议：',
      reason: 'non-user-visible-protocol',
    };

    assert.deepEqual(
      findInlineCjkLiterals(`export const marker = '协议：';`, 'fixture.ts', {
        exemptions: [exemption],
      }),
      [],
    );
  });

  it('rejects silent English-to-Chinese catalog fallbacks', () => {
    const violations = findSilentCatalogFallbacks(`export const copy = catalog[locale] ?? catalog.zh;`, 'catalog.ts');

    assert.equal(violations.length, 1);
    assert.match(violations[0]?.text ?? '', /catalog\.zh/);
  });
});

describe('PR2 migrated presentation copy', () => {
  it('keeps the migrated manifest within the planned PR2 targets', () => {
    for (const file of PR2_PRESENTATION_FILES) {
      assert.ok(PR2_TARGET_PRESENTATION_FILES.includes(file));
    }
  });

  it('selects complete Settings copy without fallback', () => {
    assert.equal(getSettingsSharedCopy('zh').modalLabel, '设置');
    assert.equal(getSettingsSharedCopy('en').modalLabel, 'Settings');
  });

  it('contains no inline user-visible Chinese literals', () => {
    const violations = PR2_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file, {
        exemptions: PR2_LITERAL_EXEMPTIONS,
      }),
    );

    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English copy back to Chinese', () => {
    const violations = PR2_CATALOG_FILES.flatMap((file) => findSilentCatalogFallbacks(repoSource(file), file));

    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});
