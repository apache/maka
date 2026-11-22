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

import { cleanup, signal } from 'nsh';
import type { Host, Input, Output } from './host';
import type { AgentModelChoice } from '../../../../packages/plugin-sdk/src/index.js';
import type { SettingsOperations } from './settingsOperations';
import { createSettingsDiscard } from './settingsDiscard';
import { sameValue } from '../../../../plugins/shared/value';
import { withThinkingLevel } from './modelSelection';
import { UiError } from './text';

type Preset = NonNullable<Output<'agent', 'preset'>>['preset'];
type Values = Required<Input<'agent', 'createPreset'>>;
export type PresetEditor = { original: Preset | null; values: Values };
export type PresetSettingsSnapshot = { editor: PresetEditor | null; opened: Values | null };
export function presetFailure(result: Output<'agent', 'createPreset'>): void {
  switch (result.kind) {
    case 'saved':
    case 'deleted':
      return;
    case 'conflict':
      throw new UiError('These settings changed elsewhere. Reload before saving again.');
    case 'notFound':
      throw new UiError('This subagent preset was deleted.');
    case 'nameConflict':
      throw new UiError('A subagent with this name already exists.');
    case 'modelUnavailable':
      throw new UiError('The preset model is unavailable. Choose another model.');
    case 'thinkingLevelUnavailable':
      throw new UiError('The preset reasoning effort is unavailable.');
    case 'invalidInput':
      throw new UiError('Invalid preset field: {field}', { field: result.field });
  }
}
export function createPresetSettings(
  host: Host,
  operations: SettingsOperations,
  restored?: PresetSettingsSnapshot,
) {
  const rows = signal<Output<'agent', 'presets'> | null>(null);
  const editor = signal<PresetEditor | null>(restored?.editor ?? null);
  const deleting = signal<Preset | null>(null);
  const models = signal<AgentModelChoice[]>([]);
  const loading = signal(false);
  const modelLoading = signal(false);
  const query = signal('');
  const modelPage = signal<Extract<Output<'agent', 'models'>, { kind: 'ready' }> | null>(null);
  const selectedModel = signal<AgentModelChoice | null>(null);
  let modelRead = 0;
  let selectedRead = 0;
  let opened = restored?.opened ?? null;
  let alive = true;
  let generation = 0;
  cleanup(() => {
    alive = false;
    ++generation;
  });
  const busy = () =>
    operations.busy() || !operations.pendingKnown() || operations.pending().length > 0;
  const close = () => {
    editor.set(null);
    deleting.set(null);
    ++modelRead;
    ++selectedRead;
    modelLoading.set(false);
    ++generation;
    loading.set(false);
  };
  const cancel = () => {
    close();
    void load();
  };
  const discarding = createSettingsDiscard(
    () => !!editor() && !sameValue(editor()!.values, opened),
    cancel,
  );
  const load = async () => {
    const read = ++generation;
    loading.set(true);
    try {
      const result = await host.query('agent', 'presets', {});
      if (alive && read === generation) rows.set(result);
    } catch (error) {
      if (alive && read === generation) operations.report(error);
    } finally {
      if (alive && read === generation) loading.set(false);
    }
  };
  const loadModels = async (restart = true) => {
    const read = ++modelRead;
    const page = restart ? null : modelPage();
    modelLoading.set(true);
    try {
      const result: Output<'agent', 'models'> = await host.query(
        'agent',
        'models',
        page?.next
          ? { kind: 'continue', revision: page.revision, cursor: page.next }
          : { kind: 'start', query: query() },
      );
      if (!alive || read !== modelRead) return;
      if (result.kind === 'changed')
        throw new UiError('The model catalog keeps changing. Retry to read the current choices.');
      modelPage.set(result);
      models.set([
        ...(restart ? [] : models()),
        ...result.choices.filter((choice) => choice.selection.kind === 'model'),
      ]);
    } catch (error) {
      if (alive && read === modelRead) throw error;
    } finally {
      if (alive && read === modelRead) modelLoading.set(false);
    }
  };
  const readSelectedModel = async () => {
    const read = ++selectedRead;
    const draft = editor();
    if (!draft || !draft.values.model.connectionId) return;
    try {
      const result = await host.query('agent', 'model', {
        backend: {
          kind: 'model',
          ...draft.values.model,
          thinkingLevel: draft.values.thinkingLevel,
        },
      });
      if (alive && read === selectedRead && sameValue(editor()?.values.model, draft.values.model))
        selectedModel.set(result.kind === 'ready' ? result.choice : null);
    } catch (error) {
      if (alive && read === selectedRead) throw error;
    }
  };
  const open = async (id: string | null) => {
    if (busy() || loading()) return;
    const read = ++generation;
    loading.set(true);
    try {
      const detail = id ? await host.query('agent', 'preset', { id }) : null;
      if (!alive || read !== generation) return;
      if (id && !detail) throw new UiError('This subagent preset was deleted.');
      const preset = detail?.preset ?? null;
      const values: Values = preset
        ? {
            name: preset.name,
            description: preset.description,
            instruction: preset.instruction,
            model: preset.model,
            thinkingLevel: preset.thinkingLevel ?? null,
            enabled: preset.enabled,
          }
        : {
            name: '',
            description: '',
            instruction: '',
            model: { connectionId: '', modelId: '' },
            thinkingLevel: null,
            enabled: true,
          };
      opened = values;
      editor.set({ original: preset, values });
      selectedModel.set(null);
      query.set('');
      await Promise.all([loadModels(), readSelectedModel()]);
    } catch (error) {
      if (alive && read === generation) operations.report(error);
    } finally {
      if (alive && read === generation) loading.set(false);
    }
  };
  const change = <K extends keyof Values>(key: K, value: Values[K]) => {
    const draft = editor();
    if (draft && !busy()) editor.set({ ...draft, values: { ...draft.values, [key]: value } });
  };
  const recovered = async (value: unknown) => {
    const result = value as Output<'agent', 'createPreset'>;
    presetFailure(result);
    if (!alive) return;
    close();
    await load();
  };
  const save = () => {
    const draft = editor();
    if (!draft) return Promise.resolve();
    return operations.run(async () => {
      const { original, values } = draft;
      let result: Output<'agent', 'createPreset'>;
      if (original) {
        const patch: Input<'agent', 'updatePreset'> = {
          id: original.id,
          expectedRevision: original.revision,
        };
        for (const key of ['name', 'description', 'instruction', 'model', 'enabled'] as const) {
          if (!sameValue(values[key], opened?.[key])) Object.assign(patch, { [key]: values[key] });
        }
        if (values.thinkingLevel !== opened?.thinkingLevel)
          patch.thinkingLevel =
            values.thinkingLevel === null
              ? { kind: 'default' }
              : { kind: 'set', value: values.thinkingLevel };
        result = await operations.mutate('agent', 'updatePreset', patch);
      } else result = await operations.mutate('agent', 'createPreset', values);
      await recovered(result);
    });
  };
  const back = () => {
    if (busy()) return false;
    if (deleting()) {
      deleting.set(null);
      return false;
    }
    if (discarding.back()) return false;
    if (editor()) {
      cancel();
      return false;
    }
    return true;
  };
  return {
    rows,
    editor,
    deleting,
    models,
    loading,
    modelLoading,
    query,
    busy,
    discarding,
    change,
    open,
    save,
    back,
    selectedModel,
    moreModels: () => {
      void loadModels(false).catch(operations.report);
    },
    hasMoreModels: () => !!modelPage()?.next,
    searchModels: (value: string) => {
      query.set(value);
      void loadModels().catch(operations.report);
    },
    cancel,
    leave: discarding.leave,
    choose: (choice: AgentModelChoice) => {
      if (choice.selection.kind === 'model') {
        ++selectedRead;
        change('model', {
          connectionId: choice.selection.connectionId,
          modelId: choice.selection.modelId,
        });
        change('thinkingLevel', null);
        selectedModel.set(choice);
      }
    },
    effort: (level: string) => {
      const draft = editor();
      if (!draft) return;
      const backend = withThinkingLevel({ kind: 'model', ...draft.values.model }, level || null);
      if (backend.kind === 'model') change('thinkingLevel', backend.thinkingLevel ?? null);
    },
    refreshModels: () => {
      void Promise.all([loadModels(), readSelectedModel()]).catch(operations.report);
    },
    refresh: () => {
      if (!editor() && !deleting() && !busy()) {
        operations.error.set('');
        void load();
      }
    },
    activate: () => {
      if (!editor()) void load();
      else void Promise.all([loadModels(), readSelectedModel()]).catch(operations.report);
    },
    deactivate: () => {
      ++generation;
      ++modelRead;
      ++selectedRead;
      loading.set(false);
      modelLoading.set(false);
      discarding.clear();
    },
    navigation: () => `${editor()?.original?.id ?? 'new'}:${!!editor()}:${!!deleting()}`,
    snapshot: (): PresetSettingsSnapshot => ({ editor: editor(), opened }),
    recovered,
    remove: () => {
      const preset = deleting();
      if (preset)
        return operations.run(async () =>
          recovered(
            await operations.mutate('agent', 'deletePreset', {
              id: preset.id,
              expectedRevision: preset.revision,
            }),
          ),
        );
    },
  };
}
export type PresetSettingsOwner = ReturnType<typeof createPresetSettings>;
