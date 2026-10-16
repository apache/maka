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

// Where a new task runs, picked from the composer's folder chip. The menu
// lists the Host's projects (the Host registers every folder a task starts
// in) and its root directories. "Choose a folder…" shows the platform's
// folder panel; the folder chosen there is found in the Host's listing by
// walking `agent.directories` from the root that holds it, 32 children a
// page, because a task starts from the Host's selection, not from a path.

import { div } from 'gpui-kit';
import { v_flex, Button, Popover } from 'gpui-base';
import { chooseFolder } from 'maka-files';
import { query, log } from './host.js';
import { palette, typeset, text, icon, ghostButton, menuSurface, menuRow, menuSeparator } from './theme.js';
import { t } from './locale.js';

/** Project pages read for the menu; the Host pages at most 16 projects. */
const MAX_PROJECT_PAGES = 16;
/** Children pages read for one folder while finding a chosen path. */
const MAX_CHILD_PAGES = 64;

export class Directories {
  /** @param {{ changed: () => void, report: (message: string) => void }} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.roots = [];
    /** The Host's projects that are not archived, as it lists them. */
    this.projects = [];
    /** Where a new task runs, `{ name, path, selection }`; null means the first root. */
    this.chosen = null;
    this.menuOpen = false;
    /** Whether a folder from the panel is being found in the Host's listing. */
    this.finding = false;
    this.projectReads = 0;
  }

  /** Where a new task runs: the chosen folder, or the first root. */
  target() {
    return this.chosen ?? this.roots[0] ?? null;
  }

  /** Opens or closes the menu; opening reads the projects again. */
  setMenuOpen(open) {
    this.menuOpen = open;
    if (open) this.loadProjects();
    this.hooks.changed();
  }

  /** Makes `directory` where new tasks run, and closes the menu. */
  choose(directory) {
    this.chosen = { name: directory.name, path: directory.path, selection: directory.selection };
    this.menuOpen = false;
    this.hooks.changed();
  }

  /** Shows the folder panel and makes the folder chosen there where new tasks run. */
  async chooseFromPanel() {
    this.menuOpen = false;
    this.hooks.changed();
    let path;
    try {
      path = await chooseFolder({ prompt: t('choose') });
    } catch (error) {
      this.hooks.report(t('chooseFolderFailed', { value: error.message }));
      return;
    }
    if (path === null) return;
    await this.chooseByPath(path);
  }

  /** Finds `path` in the Host's folders and makes it where new tasks run. */
  async chooseByPath(path) {
    this.finding = true;
    this.hooks.changed();
    try {
      this.choose(await this.find(path));
      log(`directories: new tasks run in ${path}`);
    } catch (error) {
      this.hooks.report(t('chooseFolderFailed', { value: error.message }));
    } finally {
      this.finding = false;
      this.hooks.changed();
    }
  }

  /**
   * The Host's directory at `path`: from the root that holds it, each
   * folder's children are read until the next name on the path is found.
   */
  async find(path) {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const root = this.roots
      .filter((root) => trimmed === root.path || trimmed.startsWith(`${root.path.replace(/\/$/, '')}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (root === undefined) {
      const offered = this.roots.map((root) => root.path).join(', ');
      throw new Error(
        offered === ''
          ? t('folderNotOfferedNone', { path: trimmed })
          : t('folderNotOffered', { path: trimmed, offered }),
      );
    }
    let directory = root;
    const names = trimmed.slice(root.path.length).split('/').filter(Boolean);
    for (const name of names) {
      directory = await this.child(directory, name);
    }
    return directory;
  }

  /** The child of `directory` called `name`, reading its pages in order. */
  async child(directory, name) {
    let after = null;
    for (let pages = 0; pages < MAX_CHILD_PAGES; pages += 1) {
      const page = await query('agent', 'directories', {
        kind: 'children',
        selection: directory.selection,
        after,
      });
      const found = (page.children ?? []).find((child) => child.name === name);
      if (found !== undefined) return found;
      after = page.after ?? null;
      if (after === null) break;
    }
    throw new Error(t('hostDoesNotList', { name, path: directory.path }));
  }

  /**
   * Reads every page of `agent.projects`. A page answered `changed` means
   * the list moved between pages, so the read starts over once.
   */
  async loadProjects() {
    const reading = ++this.projectReads;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const projects = [];
        let cursor = null;
        let changed = false;
        for (let pages = 0; pages < MAX_PROJECT_PAGES; pages += 1) {
          const page = await query('agent', 'projects', { kind: 'list', cursor });
          if (page.kind === 'changed') {
            changed = true;
            break;
          }
          if (page.kind !== 'projects') throw new Error(t('hostAnswered', { value: page.kind }));
          projects.push(...page.projects);
          cursor = page.next ?? null;
          if (cursor === null) break;
        }
        if (changed) continue;
        if (reading === this.projectReads) {
          this.projects = projects.filter((project) => !project.archived && project.selection !== null);
          this.hooks.changed();
        }
        return;
      }
      throw new Error(t('listKeptChanging'));
    } catch (error) {
      if (reading === this.projectReads) {
        this.hooks.report(t('projectsFailed', { value: error.message }));
      }
    }
  }

  async loadRoots() {
    try {
      const page = await query('agent', 'directories', { kind: 'roots' });
      this.roots = page.roots ?? [];
    } catch (error) {
      this.hooks.report(t('directoriesFailed', { value: error.message }));
    }
    this.hooks.changed();
  }
}

/**
 * `path` as the menu shows it: under a root the Host names `~`, from `~`.
 * @param {{ name: string, path: string }[]} roots
 */
export function shortPath(path, roots) {
  for (const root of roots) {
    if (root.name !== '~') continue;
    if (path === root.path) return '~';
    if (path.startsWith(`${root.path}/`)) return `~${path.slice(root.path.length)}`;
  }
  return path;
}

/**
 * The places the menu offers, most recently used first: the projects, by
 * their newest task in `sessions`, then the roots no project already names.
 * A project in a root's own folder goes by the root's name, as the chip
 * calls the first root before anything is chosen.
 */
export function places(directories, sessions) {
  const latest = new Map();
  for (const session of sessions) {
    const path = session.workspace?.path;
    if (typeof path === 'string' && !(session.updatedAt <= (latest.get(path) ?? -Infinity))) {
      latest.set(path, session.updatedAt);
    }
  }
  const rootNames = new Map(directories.roots.map((root) => [root.path, root.name]));
  const projects = directories.projects
    .map((project) => ({
      name: rootNames.get(project.path) ?? project.name,
      path: project.path ?? '',
      selection: project.selection,
      available: project.available,
    }))
    .sort(
      (a, b) =>
        (latest.get(b.path) ?? -Infinity) - (latest.get(a.path) ?? -Infinity) ||
        a.name.localeCompare(b.name),
    );
  const named = new Set(projects.map((place) => place.path));
  const roots = directories.roots
    .filter((root) => !named.has(root.path))
    .map((root) => ({ ...root, available: true }));
  return [...projects, ...roots];
}

/**
 * The composer's folder chip for a new task, and the menu it opens upward:
 * the places a task can run, then "Choose a folder…", which shows the
 * platform's folder panel.
 * @param {Directories} directories
 * @param {object[]} sessions the catalog's sessions, to put recent places first
 * @param {boolean} disabled
 */
export function folderPicker(directories, sessions, disabled, cx) {
  const m = palette(cx);
  const target = directories.target();
  // While a folder from the panel is being found, the chip waits for it.
  disabled = disabled || directories.finding;
  const chip = typeset(ghostButton('folder-chip', cx), 'label')
    .flex_none()
    .h(28)
    .px(8)
    .gap(4)
    .max_w(260)
    .disabled(disabled)
    .tooltip(target?.path ?? t('chooseFolder'))
    .child(icon('folder', 14, m.inkMuted))
    .child(div().min_w_0().truncate().child(target?.name || target?.path || t('chooseFolder')))
    .child(icon('chevron-down', 14, m.inkMuted));
  if (disabled) return chip;
  return Popover.new('folder-menu')
    .anchor('bottom_left')
    .open(directories.menuOpen)
    .on_open_change((open) => directories.setMenuOpen(open))
    .trigger(chip)
    .content(
      menuSurface(cx).w(340).mb(8).children(placeRows(directories, sessions, cx)),
    );
}

function placeRows(directories, sessions, cx) {
  const target = directories.target();
  const rows = places(directories, sessions).map((place, index) =>
    placeRow(`place-${index}`, place, place.path === target?.path, directories.roots, cx).on_click(() =>
      directories.choose(place),
    ),
  );
  return [
    v_flex().id('folder-places').max_h(320).overflow_y_scroll().children(rows),
    ...(rows.length > 0 ? [menuSeparator(cx)] : []),
    menuRow('folder-browse', t('chooseFolderMenu'), { icon: 'folder-open' }, cx).on_click(() =>
      directories.chooseFromPanel(),
    ),
  ];
}

/**
 * A place in the menu: its name over its folder, checked when new tasks run
 * there. The folder is written from `~` unless that would only repeat the name.
 */
function placeRow(id, place, checked, roots, cx) {
  const m = palette(cx);
  const short = shortPath(place.path, roots);
  const folder = short === (place.name || place.path) ? place.path : short;
  return typeset(Button.new(id), 'body')
    .w_full()
    .px(8)
    .py(6)
    .gap(8)
    .items_center()
    .rounded(6)
    .disabled(!place.available)
    .when(place.available, (el) => el.hover((style) => style.bg(m.activeRow)))
    .child(icon('folder', 16, m.inkMuted))
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(
          div()
            .truncate()
            .text_color(place.available ? m.ink : m.inkDisabled)
            .child(place.name || place.path),
        )
        .child(
          text(place.available ? folder : t('folderNotFound'), 'small', m.inkMuted).truncate(),
        ),
    )
    .when(checked, (el) => el.child(icon('check', 16, m.ink)));
}
