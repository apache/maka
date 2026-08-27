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
import enShellControls from './locales/en/shell-controls.json' with { type: 'json' };
import zhShellControls from './locales/zh/shell-controls.json' with { type: 'json' };

const EN_UI_COPY_RESOURCES = {
  'shell-controls': enShellControls,
};

export type UiCopyDomain = keyof typeof EN_UI_COPY_RESOURCES;

const UI_COPY_RESOURCES = {
  zh: {
    'shell-controls': zhShellControls,
  },
  en: EN_UI_COPY_RESOURCES,
} satisfies UiCatalog<Record<UiCopyDomain, unknown>>;

export type UiDomainCatalog<Domain extends UiCopyDomain> = {
  readonly [Locale in UiLocale]: (typeof UI_COPY_RESOURCES)[Locale][Domain];
};

export function getUiCopyCatalog<Domain extends UiCopyDomain>(
  domain: Domain,
): UiDomainCatalog<Domain> {
  return {
    zh: UI_COPY_RESOURCES.zh[domain],
    en: UI_COPY_RESOURCES.en[domain],
  };
}
