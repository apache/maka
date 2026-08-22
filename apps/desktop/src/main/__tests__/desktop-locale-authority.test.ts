/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

test('publishes only resolved-locale changes and allows listeners to detach', () => {
  const authority = createDesktopLocaleAuthority({
    readSettings: async () => createDefaultSettings(),
    preferredSystemLanguages: () => ['en-US'],
  });
  const observed: string[] = [];
  const unsubscribe = authority.subscribe((locale) => observed.push(locale));

  authority.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'en' },
  }));
  authority.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'zh' },
  }));
  unsubscribe();
  authority.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'en' },
  }));

  assert.deepEqual(observed, ['zh']);
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
  const observed: string[] = [];
  authority.subscribe((locale) => observed.push(locale));

  const read = authority.resolve();
  authority.observe(mergeSettings(createDefaultSettings(), {
    personalization: { uiLocale: 'zh' },
  }));
  release(createDefaultSettings());

  assert.equal(await read, 'zh');
  assert.equal(authority.current(), 'zh');
  assert.deepEqual(observed, ['zh']);
});

test('falls back to its current projection when settings cannot be read', async () => {
  const authority = createDesktopLocaleAuthority({
    readSettings: async () => { throw new Error('unreadable'); },
    preferredSystemLanguages: () => ['zh-CN'],
  });
  assert.equal(await authority.resolve(), 'zh');
});
