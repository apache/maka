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
import { formatTuiCopy, getTuiCopyCatalog, type TuiCopyDomain } from '../tui-copy-catalog.js';

const LOCALES_ROOT = fileURLToPath(new URL('../locales/', import.meta.url));
const COPY_RESOURCES = Object.fromEntries(
  readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [entry.name, readLocaleResources(entry.name)]),
) as Readonly<Record<string, Readonly<Record<string, unknown>>>>;

describe('TUI copy resources', () => {
  test('loads every supported locale and domain through the registry', () => {
    assert.deepEqual(Object.keys(COPY_RESOURCES).sort(), [...UI_LOCALES].sort());
    const domains = Object.keys(localeResources('en')).sort() as TuiCopyDomain[];
    for (const locale of UI_LOCALES) {
      for (const domain of domains) {
        assert.deepEqual(getTuiCopyCatalog(domain)[locale], domainResource(locale, domain));
      }
    }
  });

  test('keeps every locale structurally aligned by domain', () => {
    const reference = localeResources('en');
    const domains = Object.keys(reference).sort();
    for (const [locale, resources] of Object.entries(COPY_RESOURCES)) {
      assert.deepEqual(Object.keys(resources).sort(), domains, locale);
      for (const domain of domains) {
        assert.deepEqual(
          resourcePaths(resources[domain]),
          resourcePaths(reference[domain]),
          `${locale}/${domain}`,
        );
      }
    }
  });

  test('keeps interpolation placeholders aligned by domain', () => {
    const reference = localeResources('en');
    for (const [locale, resources] of Object.entries(COPY_RESOURCES)) {
      for (const [domain, resource] of Object.entries(resources)) {
        assert.deepEqual(
          resourcePlaceholders(resource),
          resourcePlaceholders(reference[domain]),
          `${locale}/${domain}`,
        );
      }
    }
    assert.deepEqual(resourcePlaceholders(domainResource('en', 'mcp-status'), true), {
      toolCount: ['count'],
    });
    assert.deepEqual(resourcePlaceholders(domainResource('en', 'pickers'), true), {
      enabledModels: ['count'],
      listProvidersFailed: ['detail'],
      saveFailed: ['detail'],
      selectedModels: ['count'],
      selectedModelsAndSave: ['count'],
      setupFailed: ['detail'],
      verifyFailed: ['detail'],
    });
    assert.deepEqual(resourcePlaceholders(domainResource('en', 'primary-guidance'), true), {});
    assert.deepEqual(resourcePlaceholders(domainResource('en', 'session-status'), true), {});
  });

  test('fails closed when a required interpolation value is absent', () => {
    assert.equal(formatTuiCopy('{count} tools', { count: 3 }), '3 tools');
    assert.throws(() => formatTuiCopy('{count} tools', {}), /Missing TUI copy placeholder count/u);
  });

  test('keeps model picker copy locale-specific', () => {
    const enPickers = domainResource('en', 'pickers');
    const zhPickers = domainResource('zh', 'pickers');
    assert.equal(enPickers.modelPickerTitle, 'Select Model');
    assert.equal(enPickers.searchLabel, 'Search');
    assert.equal(zhPickers.modelPickerTitle, '选择模型');
    assert.equal(zhPickers.searchLabel, '搜索');
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

function domainResource(locale: string, domain: string): Readonly<Record<string, unknown>> {
  const resource = localeResources(locale)[domain];
  assert.ok(
    resource && typeof resource === 'object' && !Array.isArray(resource),
    `${locale}/${domain}`,
  );
  return resource as Readonly<Record<string, unknown>>;
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

function resourcePlaceholders(
  value: unknown,
  populatedOnly = false,
): Readonly<Record<string, readonly string[]>> {
  const entries = leafEntries(value).map(
    ([path, text]) =>
      [
        path,
        [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]!).sort(),
      ] as const,
  );
  return Object.fromEntries(
    populatedOnly ? entries.filter(([, names]) => names.length > 0) : entries,
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
