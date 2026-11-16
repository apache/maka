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
import type {
  WebBackend,
  WebSettings,
  WebSnapshot,
  WebUpdate,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { sameValue } from '../../../../plugins/shared/value';
import type { Host } from './host';
import { tr } from './locale';
import { UiError } from './text';
import { createSettingsDiscard } from './settingsDiscard';
import type { SettingsOperations } from './settingsOperations';

type SettingsDraft = WebSettings & { backend: WebBackend };

export function createWebSearchSettings(
  host: Host,
  operations: SettingsOperations,
  active: () => boolean,
) {
  const snapshot = signal<WebSnapshot | null>(null);
  const draft = signal<SettingsDraft | null>(null);
  const parameters = signal({ url: '', body: '' });
  const secret = signal('');
  const loading = signal(false);
  const supported = signal(true);
  let generation = 0;
  cleanup(() => {
    generation += 1;
    secret.set('');
  });
  const setDraft = (settings: WebSettings | null) => {
    const backend: WebBackend = settings?.backend ?? { kind: 'tavily' };
    draft.set(settings ? { ...settings, backend } : null);
    const endpoint = backend.kind === 'custom' ? backend.endpoint : null;
    parameters.set({
      url: JSON.stringify(endpoint?.urlParameters ?? {}, null, 2),
      body: JSON.stringify(endpoint?.body ?? {}, null, 2),
    });
  };
  const accept = (value: WebSnapshot) => {
    snapshot.set(value);
    setDraft(value.settings);
  };
  const load = async () => {
    if (!active()) return;
    const request = ++generation;
    loading.set(true);
    try {
      const available = await host.hasService('web');
      if (generation !== request) return;
      supported.set(available);
      if (!available) return;
      const value = await host.query('web', 'snapshot', {});
      if (generation === request) accept(value);
    } catch (reason) {
      if (generation === request) operations.report(reason);
    } finally {
      if (generation === request) loading.set(false);
    }
  };
  const dirty = () => {
    const saved = snapshot()?.settings;
    const value = draft();
    if (!saved || !value) return false;
    const backend = value.backend;
    return (
      !sameValue({ ...saved, backend: saved.backend ?? { kind: 'tavily' } }, value) ||
      (backend.kind === 'custom' &&
        (parameters().url !== JSON.stringify(backend.endpoint.urlParameters, null, 2) ||
          parameters().body !== JSON.stringify(backend.endpoint.body, null, 2)))
    );
  };
  const disabled = () =>
    loading() || operations.busy() || !operations.pendingKnown() || operations.pending().length > 0;
  const discarding = createSettingsDiscard(
    () => dirty() || !!secret(),
    () => {
      setDraft(snapshot()?.settings ?? null);
      secret.set('');
    },
  );
  const req = async (
    method: 'save' | 'saveKey' | 'deleteKey' | 'checkKey',
    input: unknown,
    key?: string,
  ) => {
    const result: WebUpdate = await operations.mutate('web', method, input, key);
    switch (result.kind) {
      case 'updated':
        accept(result.snapshot);
        return;
      case 'changed':
        throw new UiError('Web search settings changed. Reload and try again.');
      case 'invalid_key':
        throw new UiError('Enter a valid search API key.');
      case 'invalid_settings':
        throw new Error(result.message);
      case 'check_unavailable':
        throw new UiError('Web search connection test is unavailable.');
    }
  };
  const edit = <K extends keyof SettingsDraft>(name: K, value: SettingsDraft[K]) => {
    const current = draft();
    if (current && !disabled()) draft.set({ ...current, [name]: value });
  };
  const selectBackend = (kind: WebBackend['kind']) => {
    const current = draft();
    if (!current || disabled() || current.backend.kind === kind) return;
    const starter =
      snapshot()?.presets.find((preset) => preset.id === current.backend.kind) ??
      snapshot()?.presets[0];
    if (kind === 'custom' && !starter) return;
    setDraft({
      ...current,
      backend: kind === 'custom' ? { kind, endpoint: starter!.endpoint } : { kind },
    });
    secret.set('');
  };
  const readObject = (text: string): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UiError('Enter a valid JSON object for the search parameters.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new UiError('Enter a valid JSON object for the search parameters.');
    return parsed as Record<string, unknown>;
  };
  const save = () =>
    operations.run(async () => {
      const current = snapshot();
      const value = draft();
      if (!current || !value || !dirty()) return;
      const backend = value.backend;
      let settings = value;
      if (backend.kind === 'custom') {
        const urlParameters = readObject(parameters().url);
        if (Object.values(urlParameters).some((entry) => typeof entry !== 'string'))
          throw new UiError('URL parameter values must be strings.');
        settings = {
          ...value,
          backend: {
            ...backend,
            endpoint: {
              ...backend.endpoint,
              url: backend.endpoint.url.trim(),
              urlParameters: urlParameters as Record<string, string>,
              body: readObject(parameters().body),
            },
          },
        };
      }
      await req('save', { revision: current.revision, settings });
    });
  const credential = (method: 'saveKey' | 'deleteKey' | 'checkKey') =>
    operations.run(async () => {
      const current = snapshot();
      if (!current || dirty()) return;
      await req(
        method,
        { settingsRevision: current.revision, revision: current.credential.revision },
        method === 'saveKey' ? secret() : undefined,
      );
      if (method !== 'checkKey') secret.set('');
    });
  return {
    snapshot,
    draft,
    parameters,
    secret,
    loading,
    supported,
    disabled,
    dirty,
    discarding,
    edit,
    selectBackend,
    save,
    credential,
    load,
    activate: () => {
      void load();
    },
    deactivate: () => {
      generation += 1;
      loading.set(false);
      snapshot.set(null);
      setDraft(null);
      secret.set('');
      discarding.clear();
    },
    refresh: () => {
      if (!dirty() && !secret() && !operations.busy()) void load();
    },
    title: () => tr('Web search'),
    navigation: () => String(snapshot()?.revision ?? ''),
    back() {
      if (!discarding.asking()) return true;
      discarding.keep();
      return false;
    },
    leave: discarding.leave,
  };
}

export type WebSearchSettingsOwner = ReturnType<typeof createWebSearchSettings>;
