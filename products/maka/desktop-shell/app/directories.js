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
import { v_flex, h_flex, Button } from 'gpui-base';
import { query } from './host.js';
import { palette, typeset, text, icon, controlButton } from './theme.js';

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
 * The start pane: the headline, the folder a new task starts in, and its
 * folders in one bordered group.
 * @param {Directories} directories
 * @param {{ creating: boolean, start: (directory: object) => void, noModel: boolean, openSettings: () => void }} actions
 */
export function startPane(directories, actions, cx) {
  const m = palette(cx);
  const current = directories.current();
  const disabled = actions.creating || directories.loading;
  const entries = current === null ? directories.roots : directories.children;
  const rows = entries.map((directory, index) =>
    folderRow(`folder-${index}`, directory.name, directory.path, index > 0, disabled, cx).on_click(
      () => directories.enter(directory),
    ),
  );
  if (directories.after !== null) {
    rows.push(
      typeset(Button.new('folders-more'), 'body')
        .w_full()
        .h(44)
        .px(16)
        .items_center()
        .border_t_1()
        .border_color(m.borderSoft)
        .text_color(m.inkMuted)
        .disabled(disabled)
        .hover((style) => style.bg(m.hover).text_color(m.ink))
        .on_click(() => directories.more())
        .child('Show more'),
    );
  }
  return v_flex()
    .id('start-pane')
    .flex_1()
    .min_h_0()
    .overflow_y_scrollbar()
    .items_center()
    .px(24)
    .pt(48)
    .pb(24)
    .child(
      v_flex()
        .w_full()
        .max_w(720)
        .gap(16)
        .child(text('What should we work on?', 'display', m.ink))
        .when(actions.noModel, (el) =>
          el.child(
            h_flex()
              .px(16)
              .py(12)
              .gap(12)
              .items_center()
              .rounded(12)
              .bg(m.warningTint)
              .child(icon('triangle-alert', 16, m.warning))
              .child(text('No model is set up yet', 'body', m.ink).flex_1())
              .child(
                controlButton('open-settings', 'Add a model in Settings', 'primary', false, cx).on_click(
                  actions.openSettings,
                ),
              ),
          ),
        )
        .child(
          text(
            current === null
              ? `A message written below starts a task in ${directories.roots[0]?.name ?? 'the first folder'}; open a folder to start it there instead.`
              : 'A message written below starts a task in this folder.',
            'body',
            m.inkMuted,
          ),
        )
        .when(current !== null, (el) =>
          el.child(
            h_flex()
              .w_full()
              .gap(8)
              .items_center()
              .child(
                controlButton('folder-up', 'Up', 'outline', disabled, cx)
                  .h(28)
                  .px(8)
                  .on_click(() => directories.up()),
              )
              .child(
                div()
                  .flex_1()
                  .min_w_0()
                  .truncate()
                  .text_size(12)
                  .line_height('20px')
                  .font_family('Menlo')
                  .text_color(m.inkMuted)
                  .child(current.path),
              )
              .child(
                controlButton('folder-start', 'Start a task here', 'primary', disabled, cx).on_click(
                  () => actions.start(current),
                ),
              ),
          ),
        )
        .child(
          v_flex()
            .w_full()
            .rounded(12)
            .border_1()
            .border_color(m.border)
            .bg(m.plate)
            .overflow_hidden()
            .when(directories.loading && rows.length === 0, (el) =>
              el.child(text('Listing…', 'body', m.inkMuted).px(16).py(12)),
            )
            .when(!directories.loading && entries.length === 0 && directories.error === null, (el) =>
              el.child(
                text(
                  current === null ? 'The Host offers no folders' : 'No folders inside',
                  'body',
                  m.inkMuted,
                )
                  .px(16)
                  .py(12),
              ),
            )
            .when(directories.error !== null, (el) =>
              el.child(
                h_flex()
                  .px(16)
                  .py(8)
                  .gap(12)
                  .items_center()
                  .child(text(directories.error, 'small', m.destructive).flex_1().min_w_0().truncate())
                  .child(
                    controlButton('folders-retry', 'List folders again', 'quiet', false, cx)
                      .h(28)
                      .on_click(() => directories.retry()),
                  ),
              ),
            )
            .children(rows),
        ),
    );
}

/** One 44px folder row: icon, name, and a chevron into it; rows after the first draw a rule above. */
function folderRow(id, name, path, rule, disabled, cx) {
  const m = palette(cx);
  return typeset(Button.new(id), 'body')
    .w_full()
    .h(44)
    .px(16)
    .gap(12)
    .items_center()
    .text_color(m.ink)
    .disabled(disabled)
    .when(rule, (el) => el.border_t_1().border_color(m.borderSoft))
    .hover((style) => style.bg(m.hover))
    .tooltip(path)
    .child(icon('folder', 16, m.inkMuted))
    .child(div().flex_1().min_w_0().truncate().child(name))
    .child(icon('chevron-right', 16, m.inkMuted));
}
