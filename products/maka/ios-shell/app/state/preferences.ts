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

import { effect, setColorScheme, signal, Storage } from 'nsh';
import { Haptics } from 'nsh/mobile';

export type AppearancePreference = 'system' | 'light' | 'dark';

const APPEARANCE_KEY = 'maka.ios.appearancePreference';
const HAPTICS_KEY = 'maka.ios.hapticsEnabled';

const appearance = signal<AppearancePreference>('system');
const haptics = signal<boolean>(true);
let installed = false;

export const appearancePreference = () => appearance();
export const hapticsEnabled = () => haptics();

export function installPreferences() {
  if (installed) return;
  installed = true;

  effect(() => {
    setColorScheme(appearance());
  });

  void Storage.getItem(APPEARANCE_KEY).then(
    (saved) => {
      if (saved === 'system' || saved === 'light' || saved === 'dark') {
        appearance.set(saved);
      }
    },
    () => {
      // Keep default 'system' if storage is unavailable in ephemeral test hosts.
    },
  );

  void Storage.getItem(HAPTICS_KEY).then(
    (saved) => {
      if (saved === 'false') haptics.set(false);
      else if (saved === 'true') haptics.set(true);
    },
    () => {},
  );
}

export async function saveAppearancePreference(next: AppearancePreference) {
  appearance.set(next);
  try {
    await Storage.setItem(APPEARANCE_KEY, next);
  } catch {
    // Preference already took effect in memory.
  }
}

export async function saveHapticsEnabled(next: boolean) {
  haptics.set(next);
  try {
    await Storage.setItem(HAPTICS_KEY, next ? 'true' : 'false');
  } catch {
    // Preference already took effect in memory.
  }
}

export function hapticSelection() {
  if (haptics()) Haptics.selection();
}

export function hapticImpact(style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' = 'light') {
  if (haptics()) Haptics.impact(style);
}

export function hapticNotification(kind: 'success' | 'warning' | 'error' = 'success') {
  if (haptics()) Haptics.notification(kind);
}
