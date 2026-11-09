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

import { host, signal, effect, cleanup } from 'nsh';
import type { ComposerEditor } from '../../../../products/maka/workbench/app/ComposerEditor';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view';
import {
  normalizeInputHistory,
  rememberInput,
  recallInput,
  completeInput,
} from '../shared/input-history';
import * as storage from './storage';
export function createQuickComposerHistory(options: {
  session(): ComposerSession | null;
  node(): ComposerEditor | null;
  active(): boolean;
  composing(): boolean;
  completionOpen(): boolean;
}) {
  const enabled = host.params.quickToolsPanel === true;
  const selection = signal({ start: 0, end: 0 });
  const history = signal<string[]>([]),
    atEnd = signal(true),
    revision = signal(0),
    dismissed = signal<string | null>(null);
  let cursor = { index: -1, draft: '', text: '' },
    alive = true;
  cleanup(() => {
    alive = false;
  });
  if (enabled)
    void storage
      .read('input-history', {})
      .then((value) => {
        if (alive) history.set(normalizeInputHistory(value).assistant);
      })
      .catch((error) => console.warn('Quick Tools history:', String(error)));
  const offered = () =>
    enabled &&
    options.active() &&
    !options.composing() &&
    !options.completionOpen() &&
    atEnd() &&
    dismissed() !== options.session()?.draft()
      ? completeInput(history(), options.session()?.draft() ?? '')
      : undefined;
  const change = (text: string) => {
    if (text !== cursor.text) cursor = { index: -1, draft: '', text: '' };
    dismissed.set(null);
    revision.set(revision() + 1);
  };
  const replace = (value: string) => {
    const owner = options.session(),
      node = options.node();
    if (!owner || !node) return;
    node.replaceRange({
      start: 0,
      end: owner.draft().length,
      text: value,
      expectedText: owner.draft(),
      expectedSelection: selection(),
    });
  };
  effect(() => {
    revision();
    const owner = options.session(),
      node = options.node();
    if (
      !enabled ||
      !owner ||
      !node ||
      !options.active() ||
      !owner.editable() ||
      options.composing() ||
      options.completionOpen() ||
      !history().length
    )
      return;
    const bindings: (() => void)[] = [];
    if (!owner.draft().includes('\n') || cursor.index >= 0) {
      for (const [key, direction] of [
        ['up', 1],
        ['down', -1],
      ] as const) {
        if (direction === -1 && cursor.index < 0) continue;
        bindings.push(
          node.bindKey(
            key,
            () => {
              const next = recallInput(
                history(),
                cursor.index,
                cursor.draft,
                owner.draft(),
                direction,
              );
              cursor = next;
              replace(next.text);
              revision.set(revision() + 1);
            },
            { repeat: false },
          ),
        );
      }
    }
    if (offered()) {
      bindings.push(
        node.bindKey(
          'tab',
          () => {
            const text = offered();
            if (text) replace(text);
          },
          { repeat: false },
        ),
      );
      bindings.push(
        node.bindKey('escape', () => dismissed.set(owner.draft()), {
          repeat: false,
        }),
      );
    }
    return () => bindings.forEach((unbind) => unbind());
  });
  return {
    offered,
    change,
    selection: (event: { start: number; end: number }) => {
      selection.set({ start: event.start, end: event.end });
      atEnd.set(event.start === options.session()?.draft().length && event.end === event.start);
    },
    remember: (text: string) => {
      if (!enabled || !text.trim()) return;
      void storage
        .update('input-history', normalizeInputHistory({}), (value) => {
          const current = normalizeInputHistory(value);
          return { ...current, assistant: rememberInput(current.assistant, text) };
        })
        .then((value) => {
          if (alive) history.set(value.assistant);
        })
        .catch((error) => console.warn('Quick Tools history:', String(error)));
    },
  };
}
