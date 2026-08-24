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
  resolveSystemUiLocale,
  resolveUiLocale,
  type UiLocale,
  type UiLocalePreference,
} from '@maka/core/ui-locale';
import type { AppSettings } from '@maka/core/settings';

type LocaleSettings = Pick<AppSettings, 'personalization'>;

export interface DesktopLocaleAuthority {
  /** Latest observed preference, resolved against the current system languages. */
  current(): UiLocale;
  /** Reads the persisted Client preference before an asynchronous native interaction. */
  resolve(): Promise<UiLocale>;
  /** Advances the synchronous projection from an already-read settings snapshot. */
  observe(settings: LocaleSettings): UiLocale;
  /** Observes resolved-locale changes for already-materialized native presentation. */
  subscribe(listener: (locale: UiLocale) => void): () => void;
}

/** One locale owner for post-settings Desktop main-process presentation. */
export function createDesktopLocaleAuthority(input: {
  readonly readSettings: () => Promise<LocaleSettings>;
  readonly preferredSystemLanguages: () => readonly string[];
}): DesktopLocaleAuthority {
  let preference: UiLocalePreference = 'auto';
  let observation = 0;
  const listeners = new Set<(locale: UiLocale) => void>();
  const systemLocale = (): UiLocale =>
    resolveSystemUiLocale([...input.preferredSystemLanguages()]);
  const current = (): UiLocale => resolveUiLocale(preference, systemLocale());
  let published = current();
  const publish = (): UiLocale => {
    const next = current();
    if (next === published) return next;
    published = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A native projection must not make a persisted settings update fail.
      }
    }
    return next;
  };
  const observe = (settings: LocaleSettings): UiLocale => {
    observation += 1;
    preference = settings.personalization.uiLocale;
    return publish();
  };
  return Object.freeze({
    current,
    observe,
    subscribe: (listener: (locale: UiLocale) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve: async () => {
      const request = ++observation;
      try {
        const settings = await input.readSettings();
        if (request === observation) preference = settings.personalization.uiLocale;
      } catch {
        // Locale presentation must not block startup or an unrelated native action.
      }
      return publish();
    },
  });
}
