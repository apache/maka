import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SETTINGS_SECTIONS } from '@maka/core';
import { getSettingsNavigationCopy } from '../../renderer/locales/settings-navigation-copy.js';
import { getSettingsSharedCopy } from '../../renderer/locales/settings-shared-copy.js';
import { SETTINGS_NAV, groupedNav, navLabel } from '../../renderer/settings/settings-nav.js';

describe('Settings navigation copy', () => {
  it('keeps every routable section unique and localized', () => {
    const navIds = SETTINGS_NAV.map((item) => item.id);
    assert.deepEqual([...navIds].sort(), [...SETTINGS_SECTIONS].sort());
    assert.equal(new Set(navIds).size, navIds.length);

    for (const locale of ['zh', 'en'] as const) {
      const sections = getSettingsNavigationCopy(locale).sections;
      assert.deepEqual(Object.keys(sections).sort(), [...SETTINGS_SECTIONS].sort());
      for (const section of SETTINGS_SECTIONS) {
        assert.ok(sections[section].label);
        assert.ok(sections[section].description);
      }
    }
  });

  it('builds localized groups and shared frame copy without fallbacks', () => {
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
    assert.equal(getSettingsSharedCopy('zh').modalLabel, '设置');
    assert.equal(getSettingsSharedCopy('en').modalLabel, 'Settings');
  });
});
