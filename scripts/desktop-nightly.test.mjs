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
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import { desktopNightlyIdentity, resolveDesktopBuildVersion } from './desktop-nightly.mjs';

test('a nightly identity is a dev build of the checked-in product version', () => {
  assert.deepEqual(
    desktopNightlyIdentity({
      productVersion: '0.2.0',
      date: new Date('2026-08-29T18:17:00Z'),
      runNumber: '42',
      sourceCommit: 'a'.repeat(40),
    }),
    {
      version: '0.2.0-dev.20260829.42',
      sourceCommit: 'a'.repeat(40),
    },
  );
});

test('a nightly package embeds only the Apache Nightlies update authority', () => {
  const version = '0.2.0-dev.20260829.42';
  const config = resolveDesktopBuilderConfig({
    MAKA_DESKTOP_NIGHTLY_VERSION: version,
  });

  assert.equal(config.extraMetadata.version, version);
  assert.equal(config.extraMetadata.makaUpdateChannel, 'nightly');
  assert.deepEqual(config.publish, [
    {
      provider: 'generic',
      url: 'https://nightlies.apache.org/maka/desktop/',
    },
  ]);
});

test('packaging observes a valid nightly version without changing product manifests', () => {
  assert.equal(
    resolveDesktopBuildVersion('0.2.0', {
      MAKA_DESKTOP_NIGHTLY_VERSION: '0.2.0-dev.20260829.42',
    }),
    '0.2.0-dev.20260829.42',
  );
  assert.equal(resolveDesktopBuildVersion('0.2.0', {}), '0.2.0');
});
