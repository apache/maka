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

import { batch, cleanup, signal } from 'nsh';
import type { Host } from './host';
import { applyLanguagePreference, currentLocale, tr } from './locale';
import { errorText, message, UiError } from './text';
import type {
  AgentGlobalInstructionsView,
  LanguagePreference,
  SettingsAssistantPreferences,
  SettingsPreferencesMutation,
  SettingsPreferencesUpdated,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { SettingsOperations } from './settingsOperations';

type PreferencesEditor =
  | {
      kind: 'personalization';
      id: number;
      basis: SettingsAssistantPreferences;
      displayName: string;
    }
  | {
      kind: 'compaction';
      id: number;
      basis: SettingsAssistantPreferences;
      prompt: string;
      useDefault: boolean;
    };
type GlobalInstructions = Extract<AgentGlobalInstructionsView, { kind: 'available' }>;
type GlobalEditor = {
  kind: 'globalInstructions';
  id: number;
  document: { basis: GlobalInstructions; content: string; conflict: boolean } | null;
};
type Editor = PreferencesEditor | GlobalEditor;
export type GeneralSettingsSnapshot = {
  facts: SettingsAssistantPreferences | null;
  editor: Editor | null;
  view: number;
};
type PreferencesAction = {
  view: number;
  policyRevision: number | null;
  kind: 'root' | PreferencesEditor['kind'];
};
export type GeneralAction =
  | PreferencesAction
  | {
      view: number;
      kind: 'globalInstructions';
      fileBasis: Pick<GlobalInstructions, 'source' | 'revision'> | null;
    };
export const assistantLanguages = (): { value: LanguagePreference; label: string }[] => [
  { value: 'auto', label: tr('Automatic') },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
];

export function createGeneralSettings(
  host: Host,
  operations: SettingsOperations,
  active: () => boolean,
  restored?: GeneralSettingsSnapshot,
  languageChanged?: (locale: string) => void,
) {
  const facts = signal<SettingsAssistantPreferences | null>(restored?.facts ?? null);
  const editor = signal<Editor | null>(restored?.editor ?? null);
  const loading = signal(false);
  const view = signal(restored?.view ?? 0);
  let alive = true;
  let enabled = false;
  let read = 0;
  const visible = () => alive && enabled && active();
  const action = (): GeneralAction => {
    const form = editor();
    if (form?.kind === 'globalInstructions')
      return {
        view: view(),
        kind: form.kind,
        fileBasis: form.document
          ? { source: form.document.basis.source, revision: form.document.basis.revision }
          : null,
      };
    return {
      view: view(),
      policyRevision: form?.basis.revision ?? facts()?.revision ?? null,
      kind: form?.kind ?? 'root',
    };
  };
  const current = (request: GeneralAction) => {
    const selected = action();
    if (!visible() || request.view !== selected.view || request.kind !== selected.kind)
      return false;
    return request.kind === 'globalInstructions'
      ? selected.kind === 'globalInstructions' &&
          request.fileBasis?.source === selected.fileBasis?.source &&
          request.fileBasis?.revision === selected.fileBasis?.revision
      : selected.kind !== 'globalInstructions' &&
          request.policyRevision === selected.policyRevision;
  };
  const blocked = () =>
    !visible() ||
    loading() ||
    operations.busy() ||
    !operations.pendingKnown() ||
    operations.pending().length > 0;
  const globalDocument = () => {
    const form = editor();
    return form?.kind === 'globalInstructions' ? form.document : null;
  };
  const disabled = () =>
    blocked() ||
    (editor()?.kind === 'globalInstructions' ? globalDocument() === null : facts() === null);
  const cancelRead = () => {
    read += 1;
    view.set(view() + 1);
    loading.set(false);
  };
  const load = async () => {
    if (!visible() || editor()) return;
    const generation = ++read;
    const capturedView = view();
    const owns = () => visible() && generation === read && capturedView === view() && !editor();
    batch(() => {
      facts.set(null);
      loading.set(true);
    });
    try {
      const result: SettingsAssistantPreferences = await host.query(
        'settings',
        'assistantPreferences',
        {},
      );
      applyLanguagePreference(result.language ?? 'auto', result.revision);
      languageChanged?.(currentLocale());
      if (owns()) facts.set(result);
    } catch (reason) {
      if (owns()) operations.report(reason);
    } finally {
      if (owns()) loading.set(false);
    }
  };
  const mutate = (
    request: PreferencesAction,
    mutation: SettingsPreferencesMutation,
    submitted: PreferencesEditor | null = null,
  ) => {
    if (!current(request) || disabled() || request.policyRevision === null) return;
    const expectedRevision = request.policyRevision;
    return operations.run(async () => {
      if (!current(request)) return;
      const result: SettingsPreferencesUpdated = await operations.mutate(
        'settings',
        'updateAssistantPreferences',
        { expectedRevision, mutation },
      );
      if (!alive) return;
      switch (result.kind) {
        case 'committed':
          if (mutation.kind === 'language') {
            applyLanguagePreference(mutation.preference, result.revision);
            languageChanged?.(currentLocale());
          }
          // Retire the submitted editor before reading new facts. A failed read
          // cannot leave a committed draft available to submit a second time.
          batch(() => {
            facts.set(null);
            if (submitted && editor()?.id === submitted.id) editor.set(null);
            cancelRead();
          });
          if (visible()) await load();
          operations.notice.set(message('Preferences saved.'));
          break;
        case 'revision_conflict':
          facts.set(null);
          throw new UiError(
            'Preferences changed elsewhere. Cancel this edit and refresh before saving again.',
          );
        case 'rejected':
          throw new UiError('The Host rejected these preferences. Check the values before saving.');
      }
    });
  };
  const loadGlobal = async (id: number) => {
    const form = editor();
    if (!visible() || form?.kind !== 'globalInstructions' || form.id !== id) return;
    const generation = ++read;
    const capturedView = view();
    const owns = () =>
      visible() &&
      generation === read &&
      capturedView === view() &&
      editor()?.kind === 'globalInstructions' &&
      editor()?.id === id;
    loading.set(true);
    try {
      const result = await host.query('agent', 'globalInstructions', {});
      if (!owns()) return;
      if (result.kind !== 'available')
        throw new UiError('Source unavailable. Reload to try again.');
      editor.set({
        kind: 'globalInstructions',
        id,
        document: { basis: result, content: result.content, conflict: false },
      });
    } catch (reason) {
      if (owns()) operations.report(reason);
    } finally {
      if (owns()) loading.set(false);
    }
  };
  const settleGlobal = async (value: unknown, submittedId: number | null) => {
    if (!alive) return;
    const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : null;
    const form = editor();
    switch (kind) {
      case 'saved':
        if (
          form?.kind === 'globalInstructions' &&
          (submittedId === null ? form.document === null : form.id === submittedId)
        ) {
          // The committed draft cannot be submitted again, even if this read fails.
          batch(() => {
            cancelRead();
            editor.set({ kind: form.kind, id: form.id, document: null });
          });
          if (visible()) await loadGlobal(form.id);
        }
        if (alive) operations.notice.set(message('Global instructions saved.'));
        return;
      case 'changed':
        if (form?.kind === 'globalInstructions' && form.document) {
          const document = form.document;
          batch(() => {
            cancelRead();
            editor.set({ ...form, document: { ...document, conflict: true } });
          });
        }
        throw new UiError(
          'Source changed. Your draft is preserved. Reload the source before saving again.',
        );
      case 'unavailable':
        throw new UiError('Source unavailable. Reload to try again.');
      default:
        throw new UiError('The Host returned an invalid global instructions result.');
    }
  };
  const recovered = async (value: unknown) => {
    if (!alive) return;
    const kind = value !== null && typeof value === 'object' && 'kind' in value ? value.kind : null;
    const form = editor();
    if (kind !== 'saved' || form?.kind !== 'globalInstructions' || !form.document)
      return settleGlobal(value, null);
    // The journal can contain another shell's action. Its saved receipt does
    // not grant ownership of this editor's unsaved draft.
    const document = form.document;
    cancelRead();
    const generation = ++read;
    const capturedView = view();
    const owns = () =>
      alive &&
      generation === read &&
      capturedView === view() &&
      editor()?.kind === 'globalInstructions' &&
      editor()?.id === form.id;
    loading.set(true);
    let current: AgentGlobalInstructionsView;
    try {
      current = await host.query('agent', 'globalInstructions', {});
    } catch (reason) {
      if (!owns()) return;
      editor.set({ ...form, document: { ...document, conflict: true } });
      throw new UiError(
        'The original action completed, but the source could not be read. Your draft is preserved. Reload before saving again. ({reason})',
        { reason: errorText(reason) },
      );
    } finally {
      if (owns()) loading.set(false);
    }
    if (!owns()) return;
    if (
      current.kind === 'available' &&
      current.source === document.basis.source &&
      current.path === document.basis.path &&
      current.exists &&
      current.content === document.content
    ) {
      editor.set({
        ...form,
        document: { basis: current, content: document.content, conflict: false },
      });
      operations.notice.set(message('Global instructions saved.'));
      return;
    }
    editor.set({ ...form, document: { ...document, conflict: true } });
    throw new UiError(
      current.kind === 'unavailable'
        ? 'The original action completed, but the source could not be read. Your draft is preserved. Reload before saving again.'
        : 'Source changed. Your draft is preserved. Reload the source before saving again.',
    );
  };
  const open = (request: GeneralAction, kind: PreferencesEditor['kind']) => {
    const basis = facts();
    if (!basis || request.kind !== 'root' || !current(request) || disabled()) return;
    cancelRead();
    editor.set(
      kind === 'personalization'
        ? {
            kind,
            id: view(),
            basis,
            displayName: basis.displayName,
          }
        : { kind, id: view(), basis, prompt: basis.compactionPrompt, useDefault: false },
    );
  };
  const dirty = () => {
    const form = editor();
    return form?.kind === 'personalization'
      ? form.displayName !== form.basis.displayName
      : form?.kind === 'compaction'
        ? form.useDefault || form.prompt !== form.basis.compactionPrompt
        : !!form?.document &&
          (!form.document.basis.exists || form.document.content !== form.document.basis.content);
  };
  const back = () => {
    if (operations.busy()) return false;
    if (!editor()) return true;
    cancelRead();
    editor.set(null);
    if (visible()) void load();
    return false;
  };
  cleanup(() => {
    alive = false;
    enabled = false;
    cancelRead();
  });
  return {
    async initializeLanguage() {
      const result = await host.query('settings', 'assistantPreferences', {});
      if (!alive) return;
      applyLanguagePreference(result.language ?? 'auto', result.revision);
      languageChanged?.(currentLocale());
    },
    snapshot: (): GeneralSettingsSnapshot => ({
      facts: facts(),
      editor: editor(),
      view: view(),
    }),
    facts,
    editor,
    loading,
    busy: operations.busy,
    action,
    navigation: () => JSON.stringify(action()),
    disabled,
    blocked,
    globalDocument,
    saveDisabled: () => disabled() || !dirty() || !!globalDocument()?.conflict,
    dirty,
    activate() {
      if (!alive || enabled) return;
      enabled = true;
      cancelRead();
      const form = editor();
      if (form?.kind === 'globalInstructions' && !form.document) void loadGlobal(form.id);
      else if (!form) void load();
    },
    deactivate() {
      enabled = false;
      cancelRead();
    },
    reset() {
      cancelRead();
      editor.set(null);
      facts.set(null);
      if (visible()) void load();
    },
    back,
    title: () =>
      editor()?.kind === 'personalization'
        ? tr('Personalization')
        : editor()?.kind === 'globalInstructions'
          ? tr('Global instructions')
          : editor()?.kind === 'compaction'
            ? tr('Compaction prompt')
            : tr('General settings'),
    open: ({ request, kind }: { request: GeneralAction; kind: PreferencesEditor['kind'] }) =>
      open(request, kind),
    openGlobal(request: GeneralAction) {
      if (request.kind !== 'root' || !current(request) || blocked()) return;
      batch(() => {
        cancelRead();
        editor.set({ kind: 'globalInstructions', id: view(), document: null });
      });
      void loadGlobal(view());
    },
    reloadGlobal(request: GeneralAction) {
      const form = editor();
      if (
        request.kind !== 'globalInstructions' ||
        !current(request) ||
        blocked() ||
        form?.kind !== 'globalInstructions'
      )
        return;
      operations.error.set('');
      cancelRead();
      void loadGlobal(form.id);
    },
    editGlobal(request: GeneralAction, content: string) {
      const form = editor();
      if (
        request.kind !== 'globalInstructions' ||
        !current(request) ||
        disabled() ||
        form?.kind !== 'globalInstructions' ||
        !form.document
      )
        return;
      editor.set({ ...form, document: { ...form.document, content } });
    },
    recovered,
    reload(request: GeneralAction) {
      if (!current(request) || request.kind !== 'root' || operations.busy() || loading()) return;
      operations.error.set('');
      void load();
    },
    cancel(request: GeneralAction) {
      if (current(request)) back();
    },
    toggle({
      request,
      kind,
    }: {
      request: GeneralAction;
      kind: 'instructions' | 'privacy' | 'titles';
    }) {
      const saved = facts();
      if (!saved || request.kind !== 'root') return;
      return mutate(
        request,
        kind === 'instructions'
          ? { kind: 'workspace_instructions', enabled: !saved.workspaceInstructions }
          : kind === 'privacy'
            ? { kind: 'privacy', incognitoActive: !saved.incognitoActive }
            : { kind: 'shell_titles', enabled: !saved.shellTitles },
      );
    },
    language({ request, preference }: { request: GeneralAction; preference: LanguagePreference }) {
      if (request.kind !== 'root' || facts()?.language === preference) return;
      return mutate(request, { kind: 'language', preference });
    },
    editName(request: GeneralAction, displayName: string) {
      const form = editor();
      if (!current(request) || disabled() || form?.kind !== 'personalization') return;
      editor.set({ ...form, displayName });
    },
    editPrompt(request: GeneralAction, prompt: string) {
      const form = editor();
      if (!current(request) || disabled() || form?.kind !== 'compaction') return;
      editor.set({ ...form, prompt, useDefault: false });
    },
    useDefault(request: GeneralAction) {
      const form = editor();
      if (!current(request) || disabled() || form?.kind !== 'compaction') return;
      editor.set({ ...form, prompt: form.basis.defaultCompactionPrompt, useDefault: true });
    },
    save(request: GeneralAction) {
      const form = editor();
      if (!form || !current(request) || disabled() || !dirty()) return;
      if (request.kind === 'globalInstructions') {
        if (form.kind !== 'globalInstructions' || !form.document || form.document.conflict) return;
        const document = form.document;
        return operations.run(async () => {
          if (!current(request)) return;
          const result = await operations.mutate('agent', 'updateGlobalInstructions', {
            source: document.basis.source,
            revision: document.basis.revision,
            content: document.content,
          });
          await settleGlobal(result, form.id);
        });
      }
      if (form.kind === 'globalInstructions') return;
      if (form.kind === 'personalization') {
        return mutate(
          request,
          {
            kind: 'personalization',
            displayName: form.displayName,
          },
          form,
        );
      }
      if (!form.useDefault && !form.prompt.trim()) {
        operations.report(new UiError('Enter a compaction prompt or choose the Host default.'));
        return;
      }
      return mutate(
        request,
        { kind: 'compaction_prompt', prompt: form.useDefault ? null : form.prompt },
        form,
      );
    },
  };
}

export type GeneralSettingsOwner = ReturnType<typeof createGeneralSettings>;
