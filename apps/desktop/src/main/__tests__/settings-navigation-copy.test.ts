import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { SETTINGS_SECTIONS } from '@maka/core';
import { getSettingsNavigationCopy } from '../../renderer/locales/settings-navigation-copy.js';
import { getSettingsSharedCopy } from '../../renderer/locales/settings-shared-copy.js';
import { SETTINGS_NAV, groupedNav, navLabel } from '../../renderer/settings/settings-nav.js';

describe('Settings navigation copy', () => {
  it('covers every SettingsSection in both locales', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getSettingsNavigationCopy(locale);
      assert.deepEqual(Object.keys(copy.sections).sort(), [...SETTINGS_SECTIONS].sort());
      for (const section of SETTINGS_SECTIONS) {
        assert.ok(copy.sections[section].label.length > 0);
        assert.ok(copy.sections[section].description.length > 0);
      }
    }
  });

  // U1 regression guard: the `account` section was routable (a SettingsSection
  // with a live case in settings-surface) yet absent from SETTINGS_NAV — so it
  // had no sidebar entry to highlight and its header fell through to the
  // `nav[0]` (通用) copy. Pin that every routable section is a nav item: an
  // orphaned section must fail here instead of silently borrowing another
  // page's title.
  it('routes every SettingsSection through a nav item (no orphaned sections)', () => {
    const navIds = SETTINGS_NAV.map((item) => item.id).sort();
    assert.deepEqual(navIds, [...SETTINGS_SECTIONS].sort());
    // Nav ids are unique — a duplicate would double-render the sidebar row.
    assert.equal(new Set(navIds).size, navIds.length);
  });

  // The page header must derive its title/description from the section→copy
  // map keyed by the active section, never from a `nav[0]`/`localizedNav[0]`
  // fallback. Source-level pin so a regression to the old fallback (which
  // rendered the wrong title over an unrouted section's body) is caught.
  it('derives the settings header from the section→copy map, not a nav fallback', async () => {
    const surface = await readFile(
      new URL('../../../src/renderer/settings/settings-surface.tsx', import.meta.url),
      'utf8',
    );
    assert.match(
      surface,
      /getSettingsNavigationCopy\(locale\)\.sections\[section\]/,
      'header copy must be keyed by the active section',
    );
    assert.match(surface, /\{headerCopy\.label\}/);
    assert.doesNotMatch(
      surface,
      /localizedNav\[0\]\?\.items\[0\]/,
      'header must not fall back to the first nav item',
    );
  });

  it('renders stable metadata with locale-specific labels', () => {
    assert.equal(navLabel('general', 'zh'), '通用');
    assert.equal(navLabel('general', 'en'), 'General');
    assert.deepEqual(
      groupedNav('en').map((group) => [group.label, group.items.map((item) => item.id)]),
      [
        ['Preferences', ['general', 'appearance']],
        ['Capabilities', ['models', 'memory', 'voice', 'bot-chat', 'search']],
        ['Activity', ['usage', 'daily-review']],
        ['System', ['data', 'permissions', 'health', 'about']],
      ],
    );
    assert.equal(groupedNav('en').flatMap((group) => group.items).find((item) => item.id === 'search')?.badge, 'Beta');
  });

  it('provides complete shared frame and failure copy without fallback', () => {
    assert.equal(getSettingsSharedCopy('zh').modalLabel, '设置');
    assert.equal(getSettingsSharedCopy('en').modalLabel, 'Settings');
    assert.equal(getSettingsSharedCopy('en').backToApp, 'Back to app');
    assert.equal(getSettingsSharedCopy('en').loading, 'Loading settings');
    assert.equal(getSettingsSharedCopy('en').unknownError, 'Something went wrong. Try again.');
  });
});
