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
import { describe, test } from 'node:test';
import {
  CLOSED_SETTINGS_SURFACE,
  closeSettingsSurface,
  consumeSearchScrollTarget,
  openSettingsSurface,
  settingsIntentSection,
  withSettingsProfileId,
  type SettingsSurface,
} from '../../renderer/features/overlays/testing.js';

const remembered: SettingsSurface = {
  ...CLOSED_SETTINGS_SURFACE,
  request: { section: 'general', profileId: 'profile-1' },
};

describe('Settings surface model', () => {
  test('a plain open keeps the remembered request and resets every sub-surface', () => {
    const detail = openSettingsSurface(remembered, { kind: 'connection-detail', slug: 'acme' });
    assert.equal(detail.connectionDetailSlug, 'acme');
    const reopened = openSettingsSurface(detail, { kind: 'settings' });
    assert.deepEqual(reopened, {
      open: true,
      request: { section: 'models', profileId: 'profile-1' },
      providerCatalogOpen: false,
      connectionDetailSlug: undefined,
      createProviderType: undefined,
    });
  });

  test('a section open merges the section into the request', () => {
    const next = openSettingsSurface(remembered, { kind: 'section', section: 'projects' });
    assert.deepEqual(next.request, { section: 'projects', profileId: 'profile-1' });
    assert.equal(next.open, true);
  });

  test('a project open replaces the whole request so a stale profile cannot leak', () => {
    const next = openSettingsSurface(remembered, { kind: 'project', profileId: 'profile-2' });
    assert.deepEqual(next.request, { section: 'projects', profileId: 'profile-2' });
  });

  test('the models openers land on models and raise only their own sub-surface', () => {
    const catalog = openSettingsSurface(remembered, { kind: 'provider-catalog' });
    assert.equal(catalog.request.section, 'models');
    assert.equal(catalog.providerCatalogOpen, true);
    assert.equal(catalog.connectionDetailSlug, undefined);
    assert.equal(catalog.createProviderType, undefined);

    const detail = openSettingsSurface(catalog, { kind: 'connection-detail', slug: 'acme' });
    assert.equal(detail.providerCatalogOpen, false);
    assert.equal(detail.connectionDetailSlug, 'acme');

    const create = openSettingsSurface(detail, { kind: 'provider-create', providerType: 'openai' });
    assert.equal(create.connectionDetailSlug, undefined);
    assert.equal(create.createProviderType, 'openai');
  });

  test('the persisted section is the one the intent lands on', () => {
    assert.equal(settingsIntentSection({ kind: 'settings' }), undefined);
    assert.equal(settingsIntentSection({ kind: 'section', section: 'general' }), 'general');
    assert.equal(settingsIntentSection({ kind: 'project', profileId: 'p' }), 'projects');
    assert.equal(settingsIntentSection({ kind: 'provider-catalog' }), 'models');
    assert.equal(settingsIntentSection({ kind: 'connection-detail', slug: 's' }), 'models');
    assert.equal(
      settingsIntentSection({ kind: 'provider-create', providerType: 'openai' }),
      'models',
    );
  });

  test('closing drops the open flag and the catalog, keeps the rest for the next open', () => {
    const detail = openSettingsSurface(remembered, { kind: 'connection-detail', slug: 'acme' });
    const closed = closeSettingsSurface({ ...detail, providerCatalogOpen: true });
    assert.equal(closed.open, false);
    assert.equal(closed.providerCatalogOpen, false);
    assert.equal(closed.connectionDetailSlug, 'acme');
    assert.deepEqual(closed.request, detail.request);
    assert.equal(closeSettingsSurface(CLOSED_SETTINGS_SURFACE), CLOSED_SETTINGS_SURFACE);
  });

  test('a profile change is a no-op when the profile is already set', () => {
    assert.equal(withSettingsProfileId(remembered, 'profile-1'), remembered);
    const next = withSettingsProfileId(remembered, 'profile-2');
    assert.deepEqual(next.request, { section: 'general', profileId: 'profile-2' });
    assert.equal(withSettingsProfileId(next, undefined).request.profileId, undefined);
  });
});

describe('Search scroll target model', () => {
  const target = { sessionId: 's1', turnId: 't1', nonce: 7 };

  test('consumes the matching nonce once', () => {
    const handled = consumeSearchScrollTarget(target, 7);
    assert.deepEqual(handled, { ...target, handled: true });
    assert.equal(consumeSearchScrollTarget(handled, 7), handled);
  });

  test('ignores a stale nonce and an absent target', () => {
    assert.equal(consumeSearchScrollTarget(target, 6), target);
    assert.equal(consumeSearchScrollTarget(null, 7), null);
  });
});
