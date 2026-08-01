import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  THEME_PALETTES,
  createDefaultSettings,
  isThemePalette,
  mergeSettings,
  normalizeSettings,
} from '../settings.js';

test('delegates bot patches and persisted normalization to the bot settings owner', () => {
  const current = createDefaultSettings();
  Object.assign(current.botChat.channels.telegram, {
    enabled: true,
    token: 'live-token',
    readiness: 'operational',
  });

  const normalized = normalizeSettings(
    mergeSettings(current, {
      botChat: {
        channels: {
          telegram: { token: '', allowedUserIds: [' 123 ', '456', '123', ''] },
        },
      },
    }),
  );
  expect(normalized.botChat.channels.telegram.token).toBe('');
  expect(normalized.botChat.channels.telegram.readiness).toBe('scaffolded');
  expect(normalized.botChat.channels.telegram.allowedUserIds).toEqual(['123', '456']);
});

describe('appearance settings boundaries', () => {
  test('validates, normalizes, and merges the palette as one closed vocabulary', () => {
    for (const palette of THEME_PALETTES) {
      expect(isThemePalette(palette)).toBe(true);
      expect(normalizeSettings({ appearance: { theme: 'auto', palette } }).appearance.palette).toBe(
        palette,
      );
    }
    for (const invalid of ['evil-unknown', '', 'Default', undefined, null, 42, {}, []]) {
      expect(isThemePalette(invalid)).toBe(false);
    }

    expect(normalizeSettings({}).appearance.palette).toBe('default');
    expect(
      normalizeSettings({ appearance: { theme: 'dark', palette: 'evil-unknown' } }).appearance,
    ).toMatchObject({ theme: 'dark', palette: 'default' });
    expect(
      mergeSettings(createDefaultSettings(), { appearance: { palette: 'onedark' } }).appearance,
    ).toMatchObject({ theme: 'auto', palette: 'onedark' });
  });

  test('drops retired appearance fields without resetting current settings', () => {
    const normalized = normalizeSettings({
      appearance: {
        theme: 'dark',
        palette: 'tokyo-night',
        toastPosition: 'top-left',
        density: 'compact',
      },
      personalization: { displayName: 'Yuejing', assistantTone: 'concise' },
    });

    expect('toastPosition' in normalized.appearance).toBe(false);
    expect('density' in normalized.appearance).toBe(false);
    expect(normalized.appearance).toMatchObject({ theme: 'dark', palette: 'tokyo-night' });
    expect(normalized.personalization).toMatchObject({
      displayName: 'Yuejing',
      assistantTone: 'concise',
    });
  });
});

test('boolean settings default, normalize, and merge through their shared boundary', () => {
  const defaults = createDefaultSettings();
  expect(defaults.notifications.runComplete).toBe(true);
  expect(defaults.system.keepSystemAwake).toBe(false);
  expect(defaults.workspaceInstructions.enabled).toBe(true);
  expect(defaults.privacy.incognitoActive).toBe(false);

  const normalized = normalizeSettings({
    notifications: { runComplete: false },
    system: { keepSystemAwake: true },
    workspaceInstructions: { enabled: false },
    privacy: { incognitoActive: true },
  });
  expect(normalized.notifications.runComplete).toBe(false);
  expect(normalized.system.keepSystemAwake).toBe(true);
  expect(normalized.workspaceInstructions.enabled).toBe(false);
  expect(normalized.privacy.incognitoActive).toBe(true);

  const malformed = normalizeSettings({
    notifications: { runComplete: 'yes' },
    system: { keepSystemAwake: 1 },
    workspaceInstructions: { enabled: 'yes' },
    privacy: { incognitoActive: 'yes' },
  });
  expect(malformed.notifications.runComplete).toBe(true);
  expect(malformed.system.keepSystemAwake).toBe(false);
  expect(malformed.workspaceInstructions.enabled).toBe(true);
  expect(malformed.privacy.incognitoActive).toBe(false);

  const merged = mergeSettings(defaults, {
    notifications: { runComplete: false },
    system: { keepSystemAwake: true },
    workspaceInstructions: { enabled: false },
    privacy: { incognitoActive: true },
  });
  expect(merged.notifications.runComplete).toBe(false);
  expect(merged.system.keepSystemAwake).toBe(true);
  expect(merged.workspaceInstructions.enabled).toBe(false);
  expect(merged.privacy.incognitoActive).toBe(true);
});

test('web-search settings stay owned by their normalization boundary', () => {
  const normalized = normalizeSettings(
    mergeSettings(createDefaultSettings(), {
      webSearch: {
        enabled: true,
        providers: { tavily: { apiKey: 'stored-key' } },
      },
    }),
  );

  expect(normalized.webSearch.enabled).toBe(true);
  expect(normalized.webSearch.providers.tavily).toMatchObject({
    apiKey: 'stored-key',
    credentialSource: 'saved',
    credentialVersion: 1,
  });
});
