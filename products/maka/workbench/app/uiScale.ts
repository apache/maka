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

import { signal, Storage } from 'nsh';
import { host as nativeHost } from 'maka/host';
import { createText, message } from './text';

const KEY = 'interface-scale';
type Values = { saved: number; current: number; text: string };
type State =
  | { kind: 'uninitialized' }
  | { kind: 'loading' }
  | ({ kind: 'ready' } & Values)
  | ({ kind: 'saving'; completion: Promise<void> } & Values);
const defaults: Values = { saved: 100, current: 100, text: '100' };
export type UiScaleSnapshot = Values & { ready: boolean };

function createUiScaleOwner() {
  const supported = nativeHost.uiScaleSupported;
  const state = signal<State>({ kind: 'uninitialized' });
  const error = createText();
  const values = (): Values => {
    const current = state();
    return current.kind === 'ready' || current.kind === 'saving' ? current : defaults;
  };
  const ready = () => {
    const current = state();
    return current.kind === 'ready' || current.kind === 'saving';
  };
  const apply = (text: string, previous: Values): Values | null => {
    error.set('');
    try {
      const percent = Number(text);
      nativeHost.previewUiScale(percent / 100);
      return { saved: previous.saved, current: percent, text };
    } catch {
      error.set(message('Enter a positive scale that the renderer can display.'));
      return null;
    }
  };
  const preview = (text: string) => {
    const current = state();
    if (!supported || current.kind !== 'ready') return false;
    const next = apply(text, current);
    state.set(next ? { kind: 'ready', ...next } : { ...current, text });
    return next !== null;
  };
  const save = (): Promise<void> => {
    const current = state();
    if (!supported || current.kind !== 'ready') return Promise.resolve();
    const next = apply(current.text, current);
    if (!next) return Promise.resolve();
    const completion = Promise.resolve()
      .then(() => Storage.setItem(KEY, String(next.current)))
      .then(() => {
        state.set({
          kind: 'ready',
          saved: next.current,
          current: next.current,
          text: String(next.current),
        });
      })
      .catch(() => {
        error.set(message('Interface scale could not be saved.'));
        state.set({ kind: 'ready', ...next });
      });
    state.set({ kind: 'saving', ...next, completion });
    return completion;
  };
  return {
    supported,
    ready,
    text: () => values().text,
    saving: () => state().kind === 'saving',
    whenIdle() {
      const current = state();
      return current.kind === 'saving' ? current.completion : Promise.resolve();
    },
    error,
    snapshot: (): UiScaleSnapshot => {
      const current = values();
      return { saved: current.saved, current: current.current, text: current.text, ready: ready() };
    },
    dirty: () => values().text !== String(values().saved),
    change(text: string) {
      const current = state();
      if (!supported || current.kind !== 'ready') return;
      state.set({ ...current, text });
      error.set('');
    },
    preview,
    cancel() {
      const current = state();
      if (current.kind === 'ready') preview(String(current.saved));
    },
    save,
    reset: () => preview('100'),
    async resetAndSave() {
      if (preview('100')) await save();
    },
    initialize(restored?: UiScaleSnapshot) {
      if (state().kind !== 'uninitialized') return;
      if (!supported) {
        state.set({ kind: 'ready', ...defaults });
        return;
      }
      if (restored?.ready) {
        const next = apply(String(restored.current), defaults) ?? defaults;
        state.set({ kind: 'ready', ...next, saved: restored.saved, text: restored.text });
        return;
      }
      state.set({ kind: 'loading' });
      void Storage.getItem(KEY)
        .then(async (value) => {
          let next = value === null ? defaults : apply(value, defaults);
          if (next === null) {
            await Storage.removeItem(KEY);
            next = apply('100', defaults) ?? defaults;
          }
          state.set({ kind: 'ready', ...next, saved: next.current });
        })
        .catch(() => {
          state.set({ kind: 'ready', ...defaults });
          error.set(message('Interface scale could not be read.'));
        });
    },
  };
}

export const uiScale = createUiScaleOwner();
export const initializeUiScale = uiScale.initialize;
