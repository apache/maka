import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import { createDesktopLocaleAuthority } from '../desktop-locale-authority.js';

test('resolves explicit preferences and observes a mid-session settings change', async () => {
  let settings = mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'zh' },
  });
  const authority = createDesktopLocaleAuthority({
    readSettings: async () => settings,
    preferredSystemLanguages: () => ['en-US'],
  });

  assert.equal(await authority.resolve(), 'zh');
  assert.equal(authority.current(), 'zh');
  settings = mergeSettings(settings, { personalization: { uiLocale: 'en' } });
  authority.observe(settings);
  assert.equal(authority.current(), 'en');
});

test('keeps automatic preference live against the current system fallback', async () => {
  let languages: readonly string[] = ['en-US'];
  const authority = createDesktopLocaleAuthority({
    readSettings: async () => createDefaultSettings(),
    preferredSystemLanguages: () => languages,
  });

  assert.equal(await authority.resolve(), 'en');
  languages = ['zh-CN'];
  assert.equal(authority.current(), 'zh');
});

test('does not let a stale read replace a newer observed preference', async () => {
  let release!: (settings: ReturnType<typeof createDefaultSettings>) => void;
  const pending = new Promise<ReturnType<typeof createDefaultSettings>>((resolve) => {
    release = resolve;
  });
  const authority = createDesktopLocaleAuthority({
    readSettings: () => pending,
    preferredSystemLanguages: () => ['en-US'],
  });

  const read = authority.resolve();
  authority.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'zh' },
  }));
  release(createDefaultSettings());

  assert.equal(await read, 'zh');
  assert.equal(authority.current(), 'zh');
});

test('falls back to its current projection when settings cannot be read', async () => {
  const authority = createDesktopLocaleAuthority({
    readSettings: async () => { throw new Error('unreadable'); },
    preferredSystemLanguages: () => ['zh-CN'],
  });
  assert.equal(await authority.resolve(), 'zh');
});
