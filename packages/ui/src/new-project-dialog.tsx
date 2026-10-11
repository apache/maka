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

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, HStack, TextInput } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';

/**
 * An optional custom name, then the folder the project lives in.
 *
 * A project is directory-backed, so this dialog cannot create one on its own —
 * it collects a name only when the user typed one, and hands that through to
 * the caller, which then asks for the directory. An empty field is a valid
 * choice: the catalog names the project after the folder. A typed name is
 * applied in the same add, so the project is registered under it rather than
 * under the folder's basename.
 *
 * One button, no 取消: the header's close control and Escape are already two
 * ways out, the convention `SessionRenameDialog` set. Choose folder is never
 * gated on the name; leaving it blank is how you take the folder name.
 */
export function NewProjectDialog(props: {
  onOpenChange(open: boolean): void;
  /** Trimmed custom name, or omitted when the field was left blank. */
  onSubmit(name?: string): void;
}) {
  const copy = getConversationCopy(useUiLocale()).workspace;
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const focusAndSelect = () => {
      input.focus({ preventScroll: true });
      input.select();
    };
    focusAndSelect();
    const frame = window.requestAnimationFrame(() => {
      // Closing a menu and opening a native dialog both manage focus. If either
      // handoff wins after this effect, take ownership back once it has settled.
      if (document.activeElement !== input) focusAndSelect();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onOpenChange(false);
    // A blank (or whitespace-only) name is not a name: omit it so the catalog's
    // folder-basename fallback applies. A typed name still rides along.
    const trimmed = name.trim();
    props.onSubmit(trimmed || undefined);
  }

  return (
    <Dialog isOpen onOpenChange={props.onOpenChange} purpose="form" width={440}>
      <Layout
        header={
          <DialogHeader title={copy.newProjectTitle} onOpenChange={props.onOpenChange} />
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="primary"
                type="submit"
                form="maka-new-project-form"
                label={copy.newProjectSubmit}
              />
            </HStack>
          </LayoutFooter>
        }
        content={
          <LayoutContent>
            <form id="maka-new-project-form" onSubmit={submit}>
              <TextInput
                ref={inputRef}
                label={copy.newProjectNameLabel}
                description={copy.newProjectDescription}
                value={name}
                // A project name is a label, not a document; the same 80 the
                // titlebar's session field takes.
                onChange={(value) => setName(value.slice(0, 80))}
                hasAutoFocus
                width="100%"
              />
            </form>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
