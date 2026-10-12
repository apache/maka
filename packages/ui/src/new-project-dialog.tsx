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
 * Naming a project before its folder is chosen.
 *
 * A project is directory-backed, so this dialog cannot create one on its own —
 * it collects the one thing the folder picker cannot (a name) and hands it to
 * the caller, which then asks for the directory. The name therefore leads: by
 * the time the picker opens, the user has already said what this is, and the
 * project is registered under it rather than under the folder's basename.
 *
 * One button, no 取消: the header's close control and Escape are already two
 * ways out, the convention `SessionRenameDialog` set. The submit is disabled
 * while the field is empty, so there is nothing to validate on the way through.
 */
export function NewProjectDialog(props: {
  onOpenChange(open: boolean): void;
  /** The typed name, trimmed and non-empty; the caller opens the folder picker. */
  onSubmit(name: string): void;
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

  const trimmed = name.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onOpenChange(false);
    // Escape and the header's close control are the two ways out; an empty field
    // cannot reach here, because the only submit affordance is disabled while it
    // is empty. The guard stands for the browsers that run implicit submission
    // through a disabled default button anyway.
    if (trimmed) props.onSubmit(trimmed);
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
                isDisabled={!trimmed}
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
