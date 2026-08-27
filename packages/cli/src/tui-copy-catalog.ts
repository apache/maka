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
export {
  defineUiCatalog as defineTuiCopyCatalog,
  formatUiCopy as formatTuiCopy,
} from '@maka/core/ui-locale';
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

export function getTuiCopyCatalog<Domain extends TuiCopyDomain>(
  domain: Domain,
): TuiDomainCatalog<Domain> {
  return {
    zh: TUI_COPY_RESOURCES.zh[domain],
    en: TUI_COPY_RESOURCES.en[domain],
  };
}
