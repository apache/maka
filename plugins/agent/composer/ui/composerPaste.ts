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

import { effect, platform } from 'nsh';
import { Window } from 'nsh/desktop';
import type { InputRef } from 'nsh';
import { keymap } from 'nsh';
import type {
  ComposerSession,
  ComposerViewInput,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { Selection } from './composerCompletionSyntax';
import { UiError } from '../../../../products/maka/workbench/app/text';

type Pending = NonNullable<ReturnType<NonNullable<ComposerViewInput['pending']>>>;
type PasteOwner = ComposerSession | Pending;
const editable = (owner: PasteOwner) =>
  'sessionId' in owner ? owner.editable() : !owner.sending();
const report = (owner: PasteOwner, reason: unknown) => {
  if ('sessionId' in owner) owner.attachments.reportError(reason);
  else owner.reportError(reason);
};

type Target<Owner> = {
  owner: Owner;
  node: InputRef;
  text: string;
  selection: Selection;
};

export function createComposerPaste<Owner extends PasteOwner>(options: {
  owner(): Owner | null;
  active(): boolean;
  editor(owner: Owner): InputRef | null;
  selection(): Selection;
  composing(): boolean;
  dismiss(): void;
}) {
  let focused: Owner | null = null;
  let dropped: { target: Target<Owner>; text: string } | null = null;
  const capture = (owner: Owner | null): Target<Owner> | null => {
    if (
      !owner ||
      options.owner() !== owner ||
      !options.active() ||
      !editable(owner) ||
      options.composing()
    )
      return null;
    const node = options.editor(owner);
    return node
      ? { owner, node, text: owner.draft(), selection: { ...options.selection() } }
      : null;
  };
  const unchanged = (target: Target<Owner>) => {
    const current = capture(target.owner);
    return (
      current !== null &&
      current.node === target.node &&
      current.text === target.text &&
      current.selection.start === target.selection.start &&
      current.selection.end === target.selection.end
    );
  };
  const insert = (target: Target<Owner>, text: string) => {
    if (!text) return;
    if (focused !== target.owner || !unchanged(target)) {
      if (options.owner() === target.owner) {
        const reason = new UiError('The input changed. Paste again.');
        if ('sessionId' in target.owner) target.owner.attachments.notify(reason);
        else target.owner.reportError(reason);
      }
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
  const clipboard = (target: Target<Owner>) => {
    options.dismiss();
    try {
      if ('sessionId' in target.owner) {
        target.owner.attachments.clearNotice();
        target.owner.attachments.pasteClipboard((text) => insert(target, text));
      } else target.owner.pasteClipboard((text) => insert(target, text));
    } catch (reason) {
      report(target.owner, reason);
    }
  };
  effect(() => {
    const owner = options.owner();
    const node = owner && options.editor(owner);
    if (!node || !owner || !options.active() || !editable(owner) || options.composing()) return;
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
  const paths = (
    target: Target<Owner>,
    uris: string[],
    onText = (text: string) => insert(target, text),
  ) => {
    try {
      if ('sessionId' in target.owner) {
        target.owner.attachments.clearNotice();
        target.owner.attachments.dropFiles(uris, onText);
      } else target.owner.dropFiles(uris, onText);
    } catch (reason) {
      report(target.owner, reason);
    }
  };
  const drop = (owner: Owner, event: { uris: string[] }) => {
    const target = capture(owner);
    if (!target) return;
    options.dismiss();
    if (platform.isTerminal) {
      paths(target, event.uris);
      return;
    }
    Window.orderFront();
    paths(target, event.uris, (text) => {
      if (!unchanged(target)) {
        insert(target, text);
        return;
      }
      dropped = { target, text };
      // A fresh focus receipt is needed even if the background field kept focus.
      target.node.blur();
      target.node.focus();
    });
  };
  return {
    drop,
    paste(owner: Owner, event: { text: string; uris: string[]; files: unknown[] }) {
      if ('sessionId' in owner) owner.attachments.clearNotice();
      if (event.uris.length) {
        const target = capture(owner);
        if (target) {
          options.dismiss();
          paths(target, event.uris);
        }
      } else if (!event.text && !event.files.length) {
        const target = capture(owner);
        if (target) clipboard(target);
      }
    },
    focus(owner: Owner) {
      if (options.owner() !== owner) return;
      focused = owner;
      const drop = dropped;
      dropped = null;
      if (drop?.target.owner !== owner) return;
      insert(drop.target, drop.text);
    },
    blur(owner: Owner) {
      if (focused === owner) focused = null;
    },
  };
}
