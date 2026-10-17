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

// Settings › Subagents: WorkHub's presets, which name the model and the tools
// a delegated task gets. WorkHub's coordinator lists them (`workhub_tasks`
// presets) and routes with one (route_preset); with no enabled one it cannot
// delegate. The calls follow the TUI's page
// (plugins/agent/subagent-settings/index.ts): `workhub.presets` reads the
// list, and `workhub.savePresets` saves all of it at the revision it was read
// at, with one entry changed, added or left out. Entries of other workers are
// kept as they are and not listed, as the TUI keeps them.

import { div } from 'gpui-kit';
import {
  v_flex,
  h_flex,
  Checkbox,
  Switch,
  Popover,
  InputState,
  Textarea,
  TextareaState,
} from 'gpui-base';
import { query, operation, log, readModels } from './host.js';
import { WORKER } from './workhub.js';
import { group, settingRow, button, choiceLabel } from './settings.js';
import {
  palette,
  typeset,
  text,
  icon,
  ghostButton,
  controlButton,
  textField,
  menuSurface,
  menuRow,
  menuLabel,
} from './theme.js';
import { t, tn, onLanguageChange } from './locale.js';

/** The most presets the Host keeps (`workhub.savePresets`). */
const MAX_ENTRIES = 64;
/** The longest name and description the Host takes, in characters. */
const MAX_NAME = 128;
const MAX_DESCRIPTION = 4000;

/**
 * The tool profiles, as the TUI offers them: id, the message key, and the
 * tools it picks from the installed ones (null for all of them).
 */
const PROFILES = [
  ['read', 'subagentsRead', ['Read', 'ReadImage', 'Glob', 'Grep']],
  ['web', 'subagentsWeb', ['WebFetch', 'WebSearch']],
  ['all', 'subagentsAllTools', null],
  ['none', 'subagentsNoTools', []],
];

export class Subagents {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, presetsChanged: (snapshot: object) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** The presets as last read or saved, `{ revision, entries }`, or null before the first read. */
    this.snapshot = null;
    /** The names of the installed tools, in the Host's order, or null before they are read. */
    this.tools = null;
    /** The first page of models the Host offers, as the composer reads it. */
    this.choices = [];
    this.loading = false;
    /** Counts the reads; an answer for an earlier one is dropped. */
    this.reads = 0;
    /** Why the last read failed, in words, until one succeeds. */
    this.loadError = null;
    /** Whether a save or a removal is under way; one change at a time. */
    this.busy = false;
    /** Why the last save or removal did not go through, in words, or null. */
    this.error = null;
    /** Whether the last save or removal went through; said until the next action. */
    this.saved = false;
    /**
     * The preset being edited, as a copy, or null while the list shows. Its
     * name and description live in the fields below until it is saved.
     */
    this.draft = null;
    /** Whether the draft is a new preset rather than one that was read. */
    this.creating = false;
    /** Whether the draft's removal waits for a confirmation. */
    this.removing = false;
    /** Whether the model menu is open. */
    this.menuOpen = false;

    this.name = InputState.new({ placeholder: t('fieldName') });
    this.description = TextareaState.new({ placeholder: t('subagentDescriptionHint'), rows: 3 });
    this.description.set_auto_grow(3, 8);
    // Save turns on and off with the name and the description's length.
    this.name.on('change', () => this.hooks.changed());
    this.description.on('change', () => this.hooks.changed());
    // The fields live as long as the app, so their placeholders follow the
    // language for good.
    onLanguageChange(() => {
      this.name.set_placeholder(t('fieldName'));
      this.description.set_placeholder(t('subagentDescriptionHint'));
    });
  }

  /** Whether the list can be acted on: it has been read, and nothing is being read or saved. */
  ready() {
    return this.snapshot !== null && !this.loading && !this.busy;
  }

  /** The presets of the worker the desktop opens, in the order they are kept. */
  listed() {
    return (this.snapshot?.entries ?? []).filter((entry) => entry.worker === WORKER);
  }

  /** Reads the presets, the installed tools and the models offered, all at once. */
  async load() {
    const read = ++this.reads;
    this.loading = true;
    this.loadError = null;
    this.saved = false;
    this.hooks.changed();
    try {
      const [snapshot, tools, choices] = await Promise.all([
        query('workhub', 'presets', {}),
        query('agent', 'tools', {}),
        offeredModels(),
      ]);
      if (read !== this.reads) return;
      this.snapshot = snapshot;
      this.tools = tools.names;
      this.choices = choices;
      log(
        `subagents: ${snapshot.entries.length} read at revision ${snapshot.revision}, ` +
          `${tools.names.length} tools, ${choices.length} models`,
      );
      this.hooks.presetsChanged(snapshot);
    } catch (error) {
      if (read !== this.reads) return;
      log(`subagents: reading failed: ${error.message}`);
      this.loadError = t('subagentsReadFailed', { value: error.message });
    } finally {
      if (read === this.reads) {
        this.loading = false;
        this.hooks.changed();
      }
    }
  }

  /**
   * Opens a copy of `entry` in the editor. A model the Host offers at
   * another revision of its connection is the same model: the draft takes
   * the current revision at once, so saving repairs the preset.
   */
  edit(entry) {
    if (!this.ready()) return;
    const draft = { ...entry, tools: [...entry.tools], model: { ...entry.model } };
    const offered = this.choices.find((choice) => sameModel(choice.selection, draft.model));
    if (offered !== undefined && offered.selection.revision !== draft.model.revision) {
      log(`subagents: ${entry.id} takes its model's current revision`);
      draft.model = selectionOf(offered.selection);
    }
    this.open(draft, false);
  }

  /** Opens a new preset for the worker, with the first `agent-N` id no entry uses. */
  create() {
    if (!this.ready() || this.snapshot.entries.length >= MAX_ENTRIES) return;
    this.open(
      {
        isolatedWorkspace: false,
        id: this.freeId(),
        name: '',
        description: '',
        worker: WORKER,
        tools: [],
        model: null,
        thinkingLevel: null,
        enabled: true,
      },
      true,
    );
  }

  open(draft, creating) {
    this.draft = draft;
    this.creating = creating;
    this.removing = false;
    this.menuOpen = false;
    this.error = null;
    this.saved = false;
    this.name.set_value(draft.name);
    this.description.set_value(draft.description);
    this.hooks.changed();
  }

  /** Back to the list; the draft is dropped. */
  close() {
    this.draft = null;
    this.creating = false;
    this.removing = false;
    this.menuOpen = false;
    this.error = null;
    this.hooks.changed();
  }

  freeId() {
    const taken = new Set(this.snapshot.entries.map((entry) => entry.id));
    let n = 1;
    while (taken.has(`agent-${n}`)) n += 1;
    return `agent-${n}`;
  }

  /** Whether the draft is a preset the Host has, which can be removed. */
  stored() {
    return (
      this.draft !== null && (this.snapshot?.entries ?? []).some((e) => e.id === this.draft.id)
    );
  }

  /** Picks the draft's model. Its thinking level belongs to the model it was set for. */
  chooseModel(choice) {
    const draft = this.draft;
    this.menuOpen = false;
    if (draft === null) return;
    if (draft.model === null || !sameModel(draft.model, choice.selection))
      draft.thinkingLevel = null;
    draft.model = selectionOf(choice.selection);
    log(`subagents: ${draft.id} uses ${choiceLabel(choice)}`);
    this.hooks.changed();
  }

  /** Gives the draft the installed tools of a profile (`tools` null for all), in the installed order. */
  useProfile(tools) {
    if (this.draft === null || this.tools === null) return;
    this.draft.tools = this.tools.filter((name) => tools === null || tools.includes(name));
    this.hooks.changed();
  }

  setTool(name, on) {
    const draft = this.draft;
    if (draft === null) return;
    const others = draft.tools.filter((tool) => tool !== name);
    draft.tools = on ? [...others, name] : others;
    this.hooks.changed();
  }

  setEnabled(on) {
    if (this.draft === null) return;
    this.draft.enabled = on;
    this.hooks.changed();
  }

  setIsolated(on) {
    if (this.draft === null) return;
    this.draft.isolatedWorkspace = on;
    this.hooks.changed();
  }

  /** Why the draft cannot be saved as it is, in words, or null when it can. */
  problem() {
    if (this.draft === null) return null;
    const name = this.name.value().trim();
    if (name === '') return t('subagentNameMissing');
    if ([...name].length > MAX_NAME) return t('subagentNameTooLong');
    if (this.draft.model === null) return t('subagentChooseModel');
    if ([...this.description.value().trim()].length > MAX_DESCRIPTION) {
      return t('subagentDescriptionTooLong');
    }
    return null;
  }

  /** Saves the draft in place of the entry with its id, or after the others when it is new. */
  save() {
    const draft = this.draft;
    if (draft === null || this.busy || this.problem() !== null) return;
    const entry = presetOf({
      ...draft,
      name: this.name.value().trim(),
      description: this.description.value().trim(),
    });
    const kept = this.snapshot.entries;
    const entries = kept.some((e) => e.id === draft.id)
      ? kept.map((e) => (e.id === draft.id ? entry : presetOf(e)))
      : [...kept.map(presetOf), entry];
    return this.commit(entries, 'saved');
  }

  /** Asks before removing the draft's preset. */
  askRemove() {
    if (this.busy || !this.stored()) return;
    this.removing = true;
    this.error = null;
    this.hooks.changed();
  }

  cancelRemove() {
    this.removing = false;
    this.hooks.changed();
  }

  remove() {
    const draft = this.draft;
    if (draft === null || this.busy) return;
    this.removing = false;
    const entries = this.snapshot.entries.filter((e) => e.id !== draft.id).map(presetOf);
    return this.commit(entries, 'removed');
  }

  /**
   * Sends `entries` as the whole list, at the revision the list was read at.
   * Saved, the editor closes. A conflict means another change came first: the
   * list the Host sent with it is taken, so the next save names its
   * revision, and the draft stays open to be checked and saved again.
   */
  async commit(entries, done) {
    const draft = this.draft;
    this.busy = true;
    this.error = null;
    this.saved = false;
    this.hooks.changed();
    try {
      const result = await operation('workhub', 'savePresets', {
        revision: this.snapshot.revision,
        entries,
      });
      switch (result.kind) {
        case 'saved':
          log(`subagents: ${done} ${draft.id} at revision ${result.snapshot.revision}`);
          this.snapshot = result.snapshot;
          if (this.draft === draft) this.close();
          this.saved = true;
          this.hooks.presetsChanged(result.snapshot);
          break;
        case 'conflict':
          log(
            `subagents: ${draft.id} conflicted; read again at revision ${result.snapshot.revision}`,
          );
          this.snapshot = result.snapshot;
          // A new preset whose id was taken meanwhile gets another.
          if (this.creating && this.stored()) draft.id = this.freeId();
          this.error = t('subagentsConflict');
          this.hooks.presetsChanged(result.snapshot);
          break;
        case 'invalid':
          log(`subagents: ${draft.id} invalid`);
          this.error = t('subagentsInvalid');
          break;
        default:
          throw new Error(t('unexpectedAnswer', { value: result.kind }));
      }
    } catch (error) {
      log(`subagents: saving ${draft.id} failed: ${error.message}`);
      this.error = t('subagentSaveFailed', { value: error.message });
    } finally {
      this.busy = false;
      this.hooks.changed();
    }
  }
}

/**
 * Whether WorkHub can delegate with `entry`: it is enabled, for the worker,
 * and its model is offered among `choices` at the same connection revision,
 * as the Host checks a selection when a task runs.
 */
export function usable(entry, choices) {
  return entry.enabled && entry.worker === WORKER && modelState(entry.model, choices) === 'ready';
}

/**
 * How the Host offers `model` now: 'ready' at its revision, 'stale' at another
 * revision of its connection (a key set, models found or turned off), or
 * 'missing'.
 */
function modelState(model, choices) {
  const choice = choices.find((c) => sameModel(c.selection, model));
  if (choice === undefined) return 'missing';
  return choice.selection.revision === model.revision ? 'ready' : 'stale';
}

/** What a preset whose model is not ready should do about it. */
function modelNote(state) {
  return state === 'stale' ? t('subagentModelChanged') : t('subagentModelUnavailable');
}

/** A model by the name the Host offers it under, or by its id when it is not offered. */
function modelName(model, choices) {
  const choice = choices.find((c) => sameModel(c.selection, model));
  return choice !== undefined ? choiceLabel(choice) : model.modelId;
}

function sameModel(a, b) {
  return a.connectionId === b.connectionId && a.modelId === b.modelId;
}

function selectionOf(model) {
  return { connectionId: model.connectionId, revision: model.revision, modelId: model.modelId };
}

/** A preset with exactly the keys the Host takes (`WorkHubPreset` refuses others). */
function presetOf(entry) {
  return {
    isolatedWorkspace: entry.isolatedWorkspace,
    id: entry.id,
    name: entry.name,
    description: entry.description,
    worker: entry.worker,
    tools: [...entry.tools],
    model: selectionOf(entry.model),
    thinkingLevel: entry.thinkingLevel ?? null,
    enabled: entry.enabled,
  };
}

/** Every model the Host offers, as the composer reads them. */
async function offeredModels() {
  const models = await readModels();
  if (models === null) throw new Error(t('modelListKeptChanging'));
  return models.choices;
}

/**
 * New subagent, for the page's header while the list shows, or null.
 * @param {Subagents} subagents
 */
export function subagentsActions(subagents, cx) {
  if (subagents.draft !== null) return null;
  const full = (subagents.snapshot?.entries.length ?? 0) >= MAX_ENTRIES;
  return button('subagent-new', t('subagentsNew'), true, !subagents.ready() || full, cx).on_click(
    () => subagents.create(),
  );
}

/**
 * The line under the page's description: why reading failed, with Retry;
 * why the last change failed while the list shows; or that it went through.
 * Null when there is nothing to say.
 * @param {Subagents} subagents
 */
export function subagentsStatus(subagents, cx) {
  const m = palette(cx);
  if (subagents.loadError !== null) {
    return h_flex()
      .gap(8)
      .items_center()
      .child(text(subagents.loadError, 'small', m.destructive).flex_1().min_w_0())
      .child(
        button('subagents-retry', t('retry'), false, subagents.loading, cx)
          .h(28)
          .on_click(() => subagents.load()),
      );
  }
  if (subagents.draft === null && subagents.error !== null) {
    return text(subagents.error, 'small', m.destructive);
  }
  if (subagents.saved) return text(t('subagentsSaved'), 'small', m.inkMuted);
  return null;
}

/**
 * The page's body: the list, or the editor in its place while a draft is open.
 * @param {Subagents} subagents
 */
export function subagentsSection(subagents, cx) {
  return subagents.draft !== null ? editor(subagents, cx) : presetList(subagents, cx);
}

function presetList(subagents, cx) {
  const m = palette(cx);
  if (subagents.snapshot === null) return div();
  const entries = subagents.listed();
  const rows = entries.map((entry) => presetRow(subagents, entry, cx));
  if (entries.length === 0) rows.push(text(t('subagentsEmpty'), 'body', m.inkMuted).py(8));
  return group(null, null, null, rows, cx);
}

/**
 * One preset: its name; its model, tools and settings; and, when WorkHub
 * cannot use its model, why, in the destructive color. Edit opens it.
 */
function presetRow(subagents, entry, cx) {
  const m = palette(cx);
  const state = modelState(entry.model, subagents.choices);
  const facts = [
    modelName(entry.model, subagents.choices),
    entry.tools.length === 0
      ? t('subagentsNoTools')
      : tn(entry.tools.length, 'subagentToolsOne', 'subagentToolsOther'),
  ];
  if (!entry.enabled) facts.push(t('turnedOff'));
  if (entry.isolatedWorkspace) facts.push(t('subagentsIsolated'));
  return h_flex()
    .w_full()
    .py(8)
    .gap(16)
    .items_center()
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(typeset(div(), 'label').text_color(m.ink).truncate().child(entry.name))
        .child(text(facts.join(' · '), 'small', m.inkMuted).truncate())
        .when(state !== 'ready', (el) =>
          el.child(text(modelNote(state), 'small', m.destructive).truncate()),
        ),
    )
    .child(
      button(`subagent-edit-${entry.id}`, t('edit'), false, !subagents.ready(), cx)
        .h(28)
        .on_click(() => subagents.edit(entry)),
    );
}

/**
 * The draft: back to the list, then its fields as settings rows, and Save,
 * Cancel and Remove below, with why Save is off or why saving failed.
 */
function editor(subagents, cx) {
  const m = palette(cx);
  const draft = subagents.draft;
  const busy = subagents.busy;
  const rows = [
    settingRow(t('fieldName'), null, div().w(260).child(textField(subagents.name, cx)), cx),
    v_flex()
      .w_full()
      .py(8)
      .gap(8)
      .child(typeset(div(), 'label').text_color(m.ink).child(t('subagentDescription')))
      .child(
        typeset(Textarea.new(subagents.description), 'body')
          .w_full()
          .px(12)
          .py(6)
          .rounded(10)
          .border_1()
          .border_color(m.borderStrong)
          .bg(m.plate)
          .text_color(m.ink)
          .focus((style) => style.border_color(m.accent)),
      ),
    modelRow(subagents, cx),
    toolRows(subagents, cx),
    switchRow(
      'subagent-isolated',
      t('subagentsIsolated'),
      t('subagentsIsolatedHelp'),
      draft.isolatedWorkspace,
      busy,
      (on) => subagents.setIsolated(on),
      cx,
    ),
    switchRow(
      'subagent-enabled',
      t('subagentsEnabled'),
      t('subagentsEnabledHelp'),
      draft.enabled,
      busy,
      (on) => subagents.setEnabled(on),
      cx,
    ),
    text(t('subagentId', { id: draft.id }), 'small', m.inkMuted).py(8),
  ];
  return v_flex()
    .w_full()
    .gap(16)
    .child(
      h_flex().child(
        typeset(ghostButton('subagent-back', cx), 'body')
          .h(28)
          .pl(4)
          .pr(10)
          .gap(4)
          .rounded(8)
          .text_color(m.inkMuted)
          .disabled(busy)
          .on_click(() => subagents.close())
          .child(icon('chevron-left', 16, m.inkMuted))
          .child(t('subagentsAll')),
      ),
    )
    .child(group(subagents.creating ? t('subagentsNew') : draft.name, null, null, rows, cx))
    .child(footer(subagents, cx));
}

/** The model row: the menu's button, and under it why WorkHub cannot use the model, when it cannot. */
function modelRow(subagents, cx) {
  const m = palette(cx);
  const model = subagents.draft.model;
  const state = model === null ? 'ready' : modelState(model, subagents.choices);
  return v_flex()
    .w_full()
    .child(settingRow(t('subagentModel'), null, modelMenu(subagents, cx), cx))
    .when(state !== 'ready', (el) =>
      el.child(text(modelNote(state), 'small', m.destructive).pb(8)),
    );
}

/** The model button and the menu it opens below: models by connection, the draft's checked. */
function modelMenu(subagents, cx) {
  const m = palette(cx);
  const model = subagents.draft.model;
  const label = model === null ? t('subagentChooseModel') : modelName(model, subagents.choices);
  const byConnection = new Map();
  for (const choice of subagents.choices) {
    const name = choice.connectionName ?? '';
    if (!byConnection.has(name)) byConnection.set(name, []);
    byConnection.get(name).push(choice);
  }
  const rows = [];
  let index = 0;
  for (const [name, choices] of byConnection) {
    if (name !== '') rows.push(menuLabel(name, cx));
    for (const choice of choices) {
      rows.push(
        menuRow(
          `subagent-model-${index}`,
          choice.label,
          { checked: model !== null && sameModel(choice.selection, model) },
          cx,
        ).on_click(() => subagents.chooseModel(choice)),
      );
      index += 1;
    }
  }
  if (rows.length === 0) {
    rows.push(menuRow('subagent-model-none', t('noModelsYet'), { disabled: true }, cx));
  }
  return Popover.new('subagent-model-menu')
    .anchor('top_right')
    .open(subagents.menuOpen)
    .on_open_change((open) => {
      subagents.menuOpen = open;
      subagents.hooks.changed();
    })
    .trigger(
      controlButton(
        'subagent-model',
        div().min_w_0().truncate().child(label),
        'outline',
        subagents.busy,
        cx,
      )
        .max_w(320)
        .tooltip(label)
        .child(icon('chevron-down', 14, m.inkMuted)),
    )
    .content(
      menuSurface(cx)
        .id('subagent-model-rows')
        .w(320)
        .max_h(360)
        .overflow_y_scroll()
        .mt(4)
        .children(rows),
    );
}

/**
 * The tools: what choosing them means, the profiles, how many are chosen,
 * and a box for each installed tool; after them, the draft's tools that are
 * not installed, checked, so they can be taken off.
 */
function toolRows(subagents, cx) {
  const m = palette(cx);
  const draft = subagents.draft;
  const busy = subagents.busy;
  const installed = subagents.tools ?? [];
  const missing = draft.tools.filter((name) => !installed.includes(name));
  return v_flex()
    .w_full()
    .py(8)
    .gap(8)
    .child(
      v_flex()
        .child(typeset(div(), 'label').text_color(m.ink).child(t('subagentTools')))
        .child(text(t('subagentToolsHelp'), 'small', m.inkMuted)),
    )
    .child(
      h_flex()
        .flex_wrap()
        .gap(8)
        .children(
          PROFILES.map(([id, label, tools]) =>
            button(`subagent-profile-${id}`, t(label), false, busy || subagents.tools === null, cx)
              .h(28)
              .on_click(() => subagents.useProfile(tools)),
          ),
        ),
    )
    .child(text(t('subagentsSelected', { count: draft.tools.length }), 'small', m.inkMuted))
    .child(
      h_flex()
        .w_full()
        .flex_wrap()
        .children(
          installed.map((name, index) =>
            toolBox(`subagent-tool-${index}`, name, draft.tools.includes(name), busy, cx)
              .w(200)
              .on_change((on) => subagents.setTool(name, on)),
          ),
        ),
    )
    .children(
      missing.map((name, index) =>
        toolBox(`subagent-missing-${index}`, t('subagentMissingTool', { name }), true, busy, cx)
          .w_full()
          .on_change((on) => subagents.setTool(name, on)),
      ),
    );
}

/** A checkbox: a 16px box, filled with the check when it is on, and its label. */
function toolBox(id, label, checked, disabled, cx) {
  const m = palette(cx);
  return typeset(Checkbox.new(id), 'body')
    .h(32)
    .pr(8)
    .gap(8)
    .flex()
    .items_center()
    .text_color(m.ink)
    .checked(checked)
    .disabled(disabled)
    .when(disabled, (el) => el.opacity(0.5))
    .child(
      div()
        .size(16)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .when(checked, (el) => el.bg(m.ink).child(icon('check', 12, m.plate)))
        .when(!checked, (el) => el.border_1().border_color(m.borderStrong)),
    )
    .child(div().flex_1().min_w_0().truncate().child(label));
}

/**
 * A settings row that ends in a switch, with its help under the title,
 * wrapped. The switch is a 36×20 track, filled with the ink when it is on,
 * and a 16px knob at the end it is set to.
 */
function switchRow(id, title, help, on, disabled, set, cx) {
  const m = palette(cx);
  return h_flex()
    .w_full()
    .py(8)
    .gap(16)
    .items_center()
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(typeset(div(), 'label').text_color(m.ink).child(title))
        .child(text(help, 'small', m.inkMuted)),
    )
    .child(
      Switch.new(id)
        .flex_none()
        .w(36)
        .h(20)
        .flex()
        .items_center()
        .rounded(10)
        .accessibility_label(title)
        .checked(on)
        .disabled(disabled)
        .on_change((value) => set(value))
        .when(disabled, (el) => el.opacity(0.5))
        .when(on, (el) => el.px(2).justify_end().bg(m.ink))
        .when(!on, (el) =>
          el.px(1).justify_start().bg(m.sunken).border_1().border_color(m.borderStrong),
        )
        .child(
          div()
            .size(16)
            .rounded(8)
            .bg(on ? m.plate : m.inkMuted),
        ),
    );
}

/**
 * Below the rows: Remove for a preset the Host has, Cancel and Save; while a
 * removal waits, the question with Remove and Cancel instead. Under them, why
 * the last save failed, or else why Save is off.
 */
function footer(subagents, cx) {
  const m = palette(cx);
  const busy = subagents.busy;
  const problem = subagents.problem();
  const actions = subagents.removing
    ? h_flex()
        .w_full()
        .gap(8)
        .items_center()
        .child(text(t('subagentRemoveQuestion'), 'body', m.ink).flex_1().min_w_0())
        .child(
          controlButton('subagent-remove-confirm', t('subagentRemove'), 'primary', busy, cx)
            .bg(m.destructive)
            .when(!busy, (el) => el.hover((style) => style.bg(m.destructive).opacity(0.84)))
            .on_click(() => subagents.remove()),
        )
        .child(
          button('subagent-remove-cancel', t('cancel'), false, busy, cx).on_click(() =>
            subagents.cancelRemove(),
          ),
        )
    : h_flex()
        .w_full()
        .gap(8)
        .items_center()
        .when(subagents.stored(), (el) =>
          el.child(
            controlButton('subagent-remove', t('subagentRemove'), 'outline', busy, cx)
              .text_color(m.destructive)
              .on_click(() => subagents.askRemove()),
          ),
        )
        .child(div().flex_1())
        .child(
          button('subagent-cancel', t('cancel'), false, busy, cx).on_click(() => subagents.close()),
        )
        .child(
          button('subagent-save', t('subagentSave'), true, busy || problem !== null, cx).on_click(
            () => subagents.save(),
          ),
        );
  const line =
    subagents.error !== null
      ? text(subagents.error, 'small', m.destructive)
      : problem !== null && !subagents.removing
        ? text(problem, 'small', m.inkMuted)
        : null;
  return v_flex()
    .w_full()
    .gap(8)
    .child(actions)
    .when(line !== null, (el) => el.child(line.w_full().text_right()));
}
