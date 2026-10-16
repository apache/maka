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

// The start pane: where a new session can start. It lists the Host's root
// directories and walks into their folders through `agent.directories`, as
// the TUI's directory picker does (plugins/agent/directory-picker): children
// come 32 at a time, and the folders walked through are kept for going up.

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { query } from './host.js';
import { button } from './composer.js';

export class Directories {
  /** @param {{ changed: () => void, report: (message: string) => void }} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.roots = [];
    /** The folders walked into, outermost first; empty while showing the roots. */
    this.path = [];
    this.children = [];
    /** The cursor of the next page of children, or null. */
    this.after = null;
    this.loading = false;
    /** Why the last listing failed, or null; the pane offers to try again. */
    this.error = null;
    this.reads = 0;
  }

  /** The folder being shown, or null at the roots. */
  current() {
    return this.path.at(-1) ?? null;
  }

  async loadRoots() {
    this.path = [];
    this.children = [];
    this.after = null;
    await this.list(async () => {
      const page = await query('agent', 'directories', { kind: 'roots' });
      this.roots = page.roots ?? [];
    });
  }

  /** Shows `directory`'s folders; `path` is where it sits. */
  async open(path) {
    const directory = path.at(-1);
    await this.list(async () => {
      const page = await query('agent', 'directories', {
        kind: 'children',
        selection: directory.selection,
        after: null,
      });
      this.path = path;
      this.children = page.children ?? [];
      this.after = page.after ?? null;
    });
  }

  enter(directory) {
    return this.open([...this.path, directory]);
  }

  up() {
    return this.path.length > 1 ? this.open(this.path.slice(0, -1)) : this.loadRoots();
  }

  async more() {
    const directory = this.current();
    if (directory === null || this.after === null) return;
    const after = this.after;
    await this.list(async () => {
      const page = await query('agent', 'directories', {
        kind: 'children',
        selection: directory.selection,
        after,
      });
      this.children = [...this.children, ...(page.children ?? [])];
      this.after = page.after ?? null;
    });
  }

  /** Runs one listing; a later one wins over an earlier one still in flight. */
  async list(read) {
    const reading = ++this.reads;
    this.loading = true;
    this.error = null;
    this.hooks.changed();
    try {
      await read();
    } catch (error) {
      if (reading === this.reads) {
        this.error = error.message;
        this.hooks.report(`Directories: ${error.message}`);
      }
    } finally {
      if (reading === this.reads) this.loading = false;
      this.hooks.changed();
    }
  }

  retry() {
    return this.path.length > 0 ? this.open(this.path) : this.loadRoots();
  }
}

/**
 * @param {Directories} directories
 * @param {{ creating: boolean, start: (directory: object) => void, noModel: boolean, openSettings: () => void }} actions
 */
export function startPane(directories, actions, cx) {
  const theme = cx.theme();
  const current = directories.current();
  const disabled = actions.creating || directories.loading;
  const entries = current === null ? directories.roots : directories.children;
  return v_flex()
    .flex_1()
    .min_h_0()
    .items_center()
    .px(theme.spacing.xl)
    .py(theme.spacing.xl)
    .gap(theme.spacing.md)
    .when(actions.noModel, (el) =>
      el.child(
        h_flex()
          .gap(theme.spacing.sm)
          .items_center()
          .child(div().text_sm().child('No model is set up yet'))
          .child(
            button('open-settings', 'Add a model in Settings', true, false, cx).on_click(
              actions.openSettings,
            ),
          ),
      ),
    )
    .child(
      div()
        .text_color(theme.colors.muted_foreground)
        .child(
          current === null
            ? 'Select a session, or write a message below to start one. Open a folder first to start it there.'
            : 'A message written below starts a session in this folder',
        ),
    )
    .when(current !== null, (el) =>
      el.child(
        h_flex()
          .w_full()
          .max_w(640)
          .gap(theme.spacing.sm)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w_0()
              .truncate()
              .font_family(theme.typography.mono)
              .text_sm()
              .child(current.path),
          )
          .child(button('folder-up', 'Up', false, disabled, cx).on_click(() => directories.up()))
          .child(
            button('folder-start', 'Start a session here', true, disabled, cx).on_click(() =>
              actions.start(current),
            ),
          ),
      ),
    )
    .child(
      v_flex()
        .id('folders')
        .w_full()
        .max_w(640)
        .flex_1()
        .min_h_0()
        .overflow_y_scrollbar()
        .gap(theme.spacing.xxs)
        .when(directories.loading, (el) =>
          el.child(div().text_sm().text_color(theme.colors.muted_foreground).child('Listing…')),
        )
        .when(!directories.loading && entries.length === 0 && directories.error === null, (el) =>
          el.child(
            div()
              .text_sm()
              .text_color(theme.colors.muted_foreground)
              .child(current === null ? 'The Host offers no folders' : 'No folders inside'),
          ),
        )
        .children(
          entries.map((directory, index) =>
            button(`folder-${index}`, directory.name, false, disabled, cx)
              .w_full()
              .justify_start()
              .tooltip(directory.path)
              .on_click(() => directories.enter(directory)),
          ),
        )
        .when(directories.after !== null, (el) =>
          el.child(
            button('folders-more', 'Show more', false, disabled, cx).on_click(() =>
              directories.more(),
            ),
          ),
        ),
    )
    .when(directories.error !== null, (el) =>
      el.child(
        button('folders-retry', 'List folders again', false, false, cx).on_click(() =>
          directories.retry(),
        ),
      ),
    );
}
