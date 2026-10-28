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

import { batch, signal } from 'nsh';
import { Storage } from 'nsh';
import { host as nativeHost } from 'maka/host';
import { createText, message } from './text';

const KEY = 'interface-scale';
const supported = nativeHost.uiScaleSupported;
const saved = signal(100);
const current = signal(100);
const text = signal('100');
const ready = signal(false);
const saving = signal(false);
const idle = new Set<() => void>();
const error = createText();
let initialized = false;

const preview = (value: string) => {
  text.set(value);
  error.set('');
  try {
    const percent = Number(value);
    nativeHost.previewUiScale(percent / 100);
    current.set(percent);
    return true;
  } catch {
    error.set(message('Enter a positive scale that the renderer can display.'));
    return false;
  }
};
const cancel = () => {
  if (!supported || !ready() || saving()) return;
  preview(String(saved()));
};
const save = async () => {
  if (!supported || !ready() || saving() || !preview(text())) return;
  const percent = current();
  saving.set(true);
  try {
    await Storage.setItem(KEY, String(percent));
    batch(() => {
      saved.set(percent);
      text.set(String(percent));
    });
  } catch {
    error.set(message('Interface scale could not be saved.'));
  } finally {
    saving.set(false);
    for (const resolve of idle) resolve();
    idle.clear();
  }
};

export type UiScaleSnapshot = { saved: number; current: number; text: string; ready: boolean };
export function initializeUiScale(restored?: UiScaleSnapshot) {
  if (initialized) return;
  initialized = true;
  if (restored?.ready && supported) {
    preview(String(restored.current));
    saved.set(restored.saved);
    text.set(restored.text);
    ready.set(true);
    return;
  }
  if (!supported) {
    ready.set(true);
    return;
  }
  void Storage.getItem(KEY)
    .then(async (value) => {
      if (value !== null && !preview(value)) {
        await Storage.removeItem(KEY);
        preview('100');
      }
      batch(() => {
        saved.set(current());
        ready.set(true);
      });
    })
    .catch(() => {
      ready.set(true);
      error.set(message('Interface scale could not be read.'));
    });
}

export const uiScale = {
  snapshot: (): UiScaleSnapshot => ({
    saved: saved(),
    current: current(),
    text: text(),
    ready: ready(),
  }),
  supported,
  ready,
  text,
  saving,
  whenIdle: () =>
    saving() ? new Promise<void>((resolve) => idle.add(resolve)) : Promise.resolve(),
  error,
  dirty: () => text() !== String(saved()),
  change(value: string) {
    text.set(value);
    error.set('');
  },
  preview,
  cancel,
  save,
  reset: () => preview('100'),
  async resetAndSave() {
    if (!supported || !ready() || saving()) return;
    preview('100');
    await save();
  },
};
