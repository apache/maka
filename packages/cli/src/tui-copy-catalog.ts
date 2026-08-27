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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import enMcpStatus from './locales/en/mcp-status.json' with { type: 'json' };
import enPickers from './locales/en/pickers.json' with { type: 'json' };
import enPrimaryGuidance from './locales/en/primary-guidance.json' with { type: 'json' };
import enSessionStatus from './locales/en/session-status.json' with { type: 'json' };
import zhMcpStatus from './locales/zh/mcp-status.json' with { type: 'json' };
import zhPickers from './locales/zh/pickers.json' with { type: 'json' };
import zhPrimaryGuidance from './locales/zh/primary-guidance.json' with { type: 'json' };
import zhSessionStatus from './locales/zh/session-status.json' with { type: 'json' };

const EN_TUI_COPY_RESOURCES = {
  'mcp-status': enMcpStatus,
  pickers: enPickers,
  'primary-guidance': enPrimaryGuidance,
  'session-status': enSessionStatus,
};

export type TuiCopyDomain = keyof typeof EN_TUI_COPY_RESOURCES;

const TUI_COPY_RESOURCES = {
  zh: {
    'mcp-status': zhMcpStatus,
    pickers: zhPickers,
    'primary-guidance': zhPrimaryGuidance,
    'session-status': zhSessionStatus,
  },
  en: EN_TUI_COPY_RESOURCES,
} satisfies UiCatalog<Record<TuiCopyDomain, unknown>>;

export type TuiDomainCatalog<Domain extends TuiCopyDomain> = {
  readonly [Locale in UiLocale]: (typeof TUI_COPY_RESOURCES)[Locale][Domain];
};

type ExactCopyShape<Actual, Expected> = Actual extends readonly unknown[]
  ? Expected extends readonly unknown[]
    ? Actual
    : never
  : Actual extends object
    ? Exclude<keyof Actual, keyof Expected> extends never
      ? {
          readonly [Key in keyof Actual]: ExactCopyShape<
            Actual[Key],
            Expected[Key & keyof Expected]
          >;
        }
      : never
    : Actual;

export function defineTuiCopyCatalog<Expected>() {
  return <Catalog extends UiCatalog<Expected>>(
    catalog: Catalog & {
      readonly [Locale in UiLocale]: ExactCopyShape<Catalog[Locale], Expected>;
    },
  ): UiCatalog<Expected> => catalog;
}

export function getTuiCopyCatalog<Domain extends TuiCopyDomain>(
  domain: Domain,
): TuiDomainCatalog<Domain> {
  return {
    zh: TUI_COPY_RESOURCES.zh[domain],
    en: TUI_COPY_RESOURCES.en[domain],
  };
}

export function formatTuiCopy(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing TUI copy placeholder ${name}`);
    return String(value);
  });
}
