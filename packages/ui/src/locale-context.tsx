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

import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import type { UiLocale } from '@maka/core/ui-locale';

const UiLocaleContext = createContext<UiLocale | undefined>(undefined);

export function syncUiLocaleDocument(
  locale: UiLocale,
  override?: UiLocale | null,
): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.setAttribute('lang', locale);
  root.setAttribute('data-maka-locale', locale);
  if (override) {
    root.setAttribute('data-maka-e2e-fixture-locale', override);
  } else {
    root.removeAttribute('data-maka-e2e-fixture-locale');
  }
}

export function LocaleProvider(props: {
  locale: UiLocale;
  override?: UiLocale | null;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    syncUiLocaleDocument(props.locale, props.override);
  }, [props.locale, props.override]);

  return (
    <UiLocaleContext.Provider value={props.locale}>
      {props.children}
    </UiLocaleContext.Provider>
  );
}

export function useUiLocale(): UiLocale {
  const locale = useContext(UiLocaleContext);
  if (!locale) {
    throw new Error('useUiLocale must be used within LocaleProvider');
  }
  return locale;
}
