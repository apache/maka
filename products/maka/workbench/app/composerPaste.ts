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

import { effect } from 'nsh';
import type { InputRef } from 'nsh';
import { keymap } from 'nsh';
import type { ComposerSession } from './Composer';
import type { Selection } from './composerCompletionSyntax';
import { UiError } from './text';

type Target = {
  owner: ComposerSession;
  node: InputRef;
  text: string;
  selection: Selection;
};

export function createComposerPaste(options: {
  session(): ComposerSession | null;
  active(): boolean;
  editor(owner: ComposerSession): InputRef | null;
  selection(): Selection;
  composing(): boolean;
  dismiss(): void;
}) {
  let focused: ComposerSession | null = null;
  const capture = (owner: ComposerSession | null): Target | null => {
    if (
      !owner ||
      options.session() !== owner ||
      !options.active() ||
      !owner.editable() ||
      options.composing()
    )
      return null;
    const node = options.editor(owner);
    return node
      ? { owner, node, text: owner.draft(), selection: { ...options.selection() } }
      : null;
  };
  const insert = (target: Target, text: string) => {
    if (!text) return;
    const current = capture(target.owner);
    if (
      !current ||
      focused !== target.owner ||
      current.node !== target.node ||
      current.text !== target.text ||
      current.selection.start !== target.selection.start ||
      current.selection.end !== target.selection.end
    ) {
      target.owner.attachments.notify(new UiError('The input changed. Paste again.'));
      return;
    }
    target.node.replaceRange({
      start: target.selection.start,
      end: target.selection.end,
      text,
      expectedText: target.text,
      expectedSelection: target.selection,
    });
  };
  const clipboard = (target: Target) => {
    options.dismiss();
    target.owner.attachments.clearNotice();
    try {
      target.owner.attachments.observeIntake(
        target.owner.attachments.client.beginClipboardPaste(),
        (text) => insert(target, text),
      );
    } catch (reason) {
      target.owner.attachments.reportError(reason);
    }
  };
  effect(() => {
    const owner = options.session();
    const node = owner && options.editor(owner);
    if (!node || !owner || !options.active() || !owner.editable() || options.composing()) return;
    const unbind = ['mod+v', 'alt+v', 'ctrl+alt+v'].map((key) =>
      keymap.bind(
        key,
        () => {
          const target = capture(owner);
          if (target) clipboard(target);
        },
        { when: 'always', within: node },
      ),
    );
    return () => unbind.forEach((remove) => remove());
  });
  const drop = (owner: ComposerSession, event: { uris: string[] }) => {
    const target = capture(owner);
    if (!target) return;
    options.dismiss();
    try {
      owner.attachments.observeIntake(owner.attachments.client.beginFileDrop(event.uris), (text) =>
        insert(target, text),
      );
    } catch (reason) {
      owner.attachments.reportError(reason);
    }
  };
  return {
    drop,
    paste(owner: ComposerSession, event: { text: string; uris: string[]; files: unknown[] }) {
      owner.attachments.clearNotice();
      if (event.uris.length) {
        drop(owner, event);
      } else if (!event.text && !event.files.length) {
        const target = capture(owner);
        if (target) clipboard(target);
      }
    },
    focus(owner: ComposerSession) {
      if (options.session() === owner) focused = owner;
    },
    blur(owner: ComposerSession) {
      if (focused === owner) focused = null;
    },
  };
}
