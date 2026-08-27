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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { UI_LOCALES } from '@maka/core/ui-locale';
import { getShellControlsCopy } from '../shell-controls-copy.js';
import { getUiCopyCatalog, type UiCopyDomain } from '../ui-copy-catalog.js';

const LOCALES_ROOT = fileURLToPath(new URL('../locales/', import.meta.url));
const COPY_RESOURCES = Object.fromEntries(
  readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, readLocaleResources(entry.name)]),
) as Readonly<Record<string, Readonly<Record<string, unknown>>>>;

describe('shared UI copy resources', () => {
  test('loads every supported locale and domain through the registry', () => {
    assert.deepEqual(Object.keys(COPY_RESOURCES).sort(), [...UI_LOCALES].sort());
    const domains = Object.keys(localeResources('en')).sort() as UiCopyDomain[];
    for (const locale of UI_LOCALES) {
      for (const domain of domains) {
        assert.deepEqual(getUiCopyCatalog(domain)[locale], domainResource(locale, domain));
      }
    }
  });

  test('keeps every locale structurally and parametrically aligned', () => {
    const reference = localeResources('en');
    for (const [locale, resources] of Object.entries(COPY_RESOURCES)) {
      assert.deepEqual(Object.keys(resources).sort(), Object.keys(reference).sort(), locale);
      for (const [domain, resource] of Object.entries(resources)) {
        assert.deepEqual(resourcePaths(resource), resourcePaths(reference[domain]), `${locale}/${domain}`);
        assert.deepEqual(
          resourcePlaceholders(resource),
          resourcePlaceholders(reference[domain]),
          `${locale}/${domain}`,
        );
      }
    }
  });

  test('preserves shell control copy and plural behavior', () => {
    const en = getShellControlsCopy('en');
    const zh = getShellControlsCopy('zh');

    assert.equal(en.navigation.buildStamp('1.2.3'), 'Current build 1.2.3');
    assert.equal(en.navigation.updateDownloaded('1.2.3'), 'Update 1.2.3 downloaded. Restart to install.');
    assert.equal(en.navigation.pendingTasks(2), 'Scheduled tasks, 2 active');
    assert.equal(en.search.results(1), '1 match');
    assert.equal(en.search.results(2), '2 matches');
    assert.equal(en.search.truncatedResults(20), 'Many results; showing the first 20');
    assert.equal(zh.navigation.buildStamp('1.2.3'), '当前版本 1.2.3');
    assert.equal(zh.navigation.pendingTasks(2), '定时任务，2 条进行中');
    assert.equal(zh.search.results(2), '找到 2 条匹配');
  });
});

function readLocaleResources(locale: string): Readonly<Record<string, unknown>> {
  const localeRoot = join(LOCALES_ROOT, locale);
  return Object.fromEntries(
    readdirSync(localeRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => [
        entry.name.slice(0, -'.json'.length),
        JSON.parse(readFileSync(join(localeRoot, entry.name), 'utf8')) as unknown,
      ]),
  );
}

function localeResources(locale: string): Readonly<Record<string, unknown>> {
  const resources = COPY_RESOURCES[locale];
  assert.ok(resources, `missing ${locale} locale`);
  return resources;
}

function domainResource(locale: string, domain: string): unknown {
  const resource = localeResources(locale)[domain];
  assert.notEqual(resource, undefined, `${locale}/${domain}`);
  return resource;
}

function resourcePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => resourcePaths(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, item]) => resourcePaths(item, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function resourcePlaceholders(value: unknown): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    leafEntries(value).map(([path, text]) => [
      path,
      [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]!).sort(),
    ]),
  );
}

function leafEntries(value: unknown, prefix = ''): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafEntries(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      leafEntries(item, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, String(value)]];
}
