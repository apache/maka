import assert from 'node:assert/strict';
import test from 'node:test';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';
import { aboutUpdateStatusDetail } from '../../renderer/settings/about-update-status.js';

const copy = getSettingsPreferencesCopy('zh').about;

test('dev builds always show the development-build help line', () => {
  assert.equal(
    aboutUpdateStatusDetail(
      { state: 'not-available', currentVersion: '0.1.9' },
      copy,
      { isDevBuild: true },
    ),
    copy.updateDevBuildHelp,
  );
});

test('maps idle, latest, downloading, and error states for packaged builds', () => {
  assert.equal(aboutUpdateStatusDetail(null, copy, { isDevBuild: false }), copy.updateIdle);
  assert.equal(
    aboutUpdateStatusDetail(
      { state: 'not-available', currentVersion: '0.1.9', latestVersion: '0.1.9' },
      copy,
      { isDevBuild: false },
    ),
    copy.updateNotAvailable,
  );
  assert.equal(
    aboutUpdateStatusDetail(
      {
        state: 'downloading',
        currentVersion: '0.1.9',
        latestVersion: '0.2.0',
        progress: { percent: 42.4 },
      },
      copy,
      { isDevBuild: false },
    ),
    copy.updateDownloading('0.2.0', 42),
  );
  assert.equal(
    aboutUpdateStatusDetail(
      {
        state: 'error',
        currentVersion: '0.1.9',
        operation: 'check',
        message: 'network down',
      },
      copy,
      { isDevBuild: false },
    ),
    'network down',
  );
});
