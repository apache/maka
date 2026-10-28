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

import { cleanup, computed, signal } from 'nsh';
import { host } from './host';
import { message, UiError } from './text';
import type {
  CatalogMutationResult,
  CodeLanguage,
  ConnectionVersionBasis,
  CredentialStatus,
  ModelOverride,
  ModelSelection,
  SettingsConnectionDetail,
  SettingsConnectionsRead,
  SettingsConnectionSummary,
  SettingsProvider,
  SettingsProvidersPage,
  SettingsProviderSummary,
  SettingsModelLimitSettings,
  SettingsModelDefaults,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/generated/runtime';

import {
  credentialBasis,
  settingsRejection as rejection,
  type SettingsOperations,
} from './settingsOperations';
import { createConnectionLogin, type LoginAction } from './connectionLoginState.ts';

type Detail = Extract<SettingsConnectionDetail, { kind: 'ready' }>;
export type ConnectionEditor = {
  instance: number;
  baseline: Detail | null;
  provider: SettingsProvider;
  name: string;
  slug: string;
  baseUrl: string;
  enabled: boolean;
  overlay: string;
  apiKey: string;
};
export type ConnectionAction = { editor: number; revision: number | null };
export type ModelAction = ConnectionAction & {
  modelId: string;
  originalId: string | null;
};
export type RemovalAction = ConnectionAction & {
  kind: 'connection' | 'key' | 'model';
  modelId: string | null;
};
export const modelLimitFields = [
  {
    key: 'contextWindow',
    label: 'Context window (tokens)',
    hint: 'Total input and output capacity. Empty uses the model default.',
  },
  {
    key: 'inputLimit',
    label: 'Input limit (tokens)',
    hint: 'Independent input ceiling. Empty uses the model default.',
  },
  {
    key: 'maxOutputTokens',
    label: 'Maximum output (tokens)',
    hint: 'Requested output budget per step, capped by the provider and remaining capacity. Empty uses the model default.',
  },
  {
    key: 'compactionThreshold',
    label: 'Compaction threshold (tokens)',
    hint: 'Retained tokens that trigger automatic compaction. Empty uses 85% of the smaller context window and input limit.',
  },
] as const;
export type ModelEditor = {
  limits: Record<(typeof modelLimitFields)[number]['key'], string>;
  codeMode: boolean | null;
  codeModeLanguage: CodeLanguage | null;
  applyPatch: boolean | null;
  originalId: string | null;
  id: string;
  label: string;
  thinkingLevels: ThinkingLevel[] | null;
  defaultThinkingLevel: ThinkingLevel | null;
  defaults: SettingsModelDefaults | null;
  effective: {
    thinkingLevels: ThinkingLevel[];
    defaultThinkingLevel: ThinkingLevel | null;
    limits: SettingsModelLimitSettings | null;
  } | null;
};
export type SettingsPage = 'connections' | 'providers' | 'connection' | 'models' | 'model';
export const thinkingLevels: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);
const searchTerms = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, terms: string[]) => terms.every((term) => text.includes(term));
const basis = (detail: Detail): ConnectionVersionBasis => ({
  connectionId: detail.target.connectionId,
  revision: detail.target.revision,
});
function overlay(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UiError('Advanced request JSON must be valid JSON.');
  }
  if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw new UiError('Advanced request JSON must be an object or null.');
  return value as Record<string, unknown> | null;
}

export function createModelSettings(
  changed: () => void,
  operations: SettingsOperations,
  active: () => boolean,
  initialModel?: ModelSelection,
) {
  const { busy, error, notice, pending, pendingKnown, report, mutate, run } = operations;
  const page = signal<SettingsPage>('connections');
  const connections = signal<SettingsConnectionSummary[]>([]);
  const providers = signal<SettingsProviderSummary[]>([]);
  const connectionQuery = signal('');
  const providerQuery = signal('');
  const modelQuery = signal('');
  const revision = signal<number | null>(null);
  const defaultTarget = signal<{
    connectionId: string;
    modelId: string;
  } | null>(null);
  const next = signal<number | null>(null);
  const providerNext = signal<number | null>(null);
  const editor = signal<ConnectionEditor | null>(null);
  const model = signal<ModelEditor | null>(null);
  const modelLoading = signal(false);
  const credential = signal<CredentialStatus | null>(null);
  const loading = signal(false);
  const discovery = signal<'idle' | 'fetching' | 'ready' | 'failed'>('idle');
  const confirmation = signal<'connection' | 'key' | 'model' | null>(null);
  const connectionIndex = computed(() =>
    connections().map((item) => ({
      item,
      text: [
        item.name,
        item.slug,
        item.basis.connectionId,
        item.provider.name,
        item.provider.packageId,
        item.provider.entryId,
      ]
        .join('\n')
        .toLowerCase(),
    })),
  );
  const providerIndex = computed(() =>
    providers().map((item) => ({
      item,
      text: [item.label, item.identity.name, item.identity.packageId, item.identity.entryId]
        .join('\n')
        .toLowerCase(),
    })),
  );
  const editing = computed(() => editor()?.baseline?.editing);
  const modelProvider = computed(() =>
    [editor()?.provider.descriptor.label ?? '', editor()?.provider.identity.name ?? ''].join('\n'),
  );
  const modelIndex = computed(() => {
    const facts = editing();
    return (facts?.enabledModelIds ?? []).map((id) => ({
      id,
      text: [id, facts?.modelOverrides?.[id]?.displayName ?? '', modelProvider()]
        .join('\n')
        .toLowerCase(),
    }));
  });
  const filteredConnections = computed(() => {
    const terms = searchTerms(connectionQuery());
    return connectionIndex()
      .filter(({ text }) => matches(text, terms))
      .map(({ item }) => item);
  });
  const filteredProviders = computed(() => {
    const terms = searchTerms(providerQuery());
    return providerIndex()
      .filter(({ text }) => matches(text, terms))
      .map(({ item }) => item);
  });
  const filteredModels = computed(() => {
    const terms = searchTerms(modelQuery());
    return modelIndex()
      .filter(({ text }) => matches(text, terms))
      .map(({ id }) => id);
  });
  let alive = true;
  let read = 0;
  let editorInstance = 0;
  cleanup(() => {
    alive = false;
    read += 1;
    editor.set(null);
  });
  const action = (): ConnectionAction => ({
    editor: editor()!.instance,
    revision: editor()!.baseline?.target.revision ?? null,
  });
  const current = (request: ConnectionAction) =>
    alive &&
    active() &&
    editor()?.instance === request.editor &&
    (editor()?.baseline?.target.revision ?? null) === request.revision;
  const modelAction = (): ModelAction => ({
    ...action(),
    modelId: model()!.id,
    originalId: model()!.originalId,
  });
  const currentModel = (request: ModelAction) =>
    current(request) &&
    model()?.id === request.modelId &&
    model()?.originalId === request.originalId;
  const cancelRead = () => {
    read += 1;
    loading.set(false);
    modelLoading.set(false);
  };
  const loadConnections = async (more = false) => {
    if (!alive || !active() || loading() || (more && next() === null)) return;
    const generation = ++read;
    const extent = more
      ? connections().length + 16
      : page() === 'connections'
        ? Math.max(16, connections().length)
        : 16;
    loading.set(true);
    error.set('');
    try {
      let rows = more ? connections() : [];
      let cursor = more ? next() : null;
      let version = revision();
      for (;;) {
        let request: SettingsConnectionsRead = { kind: 'start' };
        if (cursor !== null) {
          if (version === null) throw new UiError('The connection catalog revision is missing.');
          request = { kind: 'continue', revision: version, offset: cursor };
        }
        const result = await host.query('settings', 'connections', request);
        if (!alive || !active() || generation !== read) return;
        if (result.kind === 'changed') {
          rows = [];
          cursor = null;
          version = null;
          continue;
        }
        if (cursor !== null && result.next !== null && result.next <= cursor)
          throw new UiError('The connection catalog did not advance.');
        rows = [...rows, ...result.connections];
        cursor = result.next;
        version = result.revision;
        connections.set(rows);
        revision.set(version);
        next.set(cursor);
        defaultTarget.set(result.defaultTarget);
        if (
          cursor !== null &&
          ((page() === 'connections' && connectionQuery().trim()) || rows.length < extent)
        )
          continue;
        break;
      }
    } catch (reason) {
      if (generation === read) report(reason);
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const loadProviders = async (more = false) => {
    const start = more ? providerNext() : 0;
    if (!alive || !active() || loading() || start === null || page() !== 'providers') return;
    let offset = start;
    const generation = ++read;
    loading.set(true);
    error.set('');
    try {
      let rows = more ? providers() : [];
      for (;;) {
        const result: SettingsProvidersPage = await host.query('settings', 'providers', { offset });
        if (!alive || !active() || generation !== read) return;
        if (result.next !== null && result.next <= offset)
          throw new UiError('The provider catalog did not advance.');
        rows = [...rows, ...result.providers];
        providers.set(rows);
        providerNext.set(result.next);
        if (result.next === null || !providerQuery().trim()) break;
        offset = result.next;
      }
    } catch (reason) {
      if (generation === read) report(reason);
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const searchConnections = (text: string) => {
    if (!alive || !active() || page() !== 'connections') return;
    connectionQuery.set(text);
    if (text.trim() && next() !== null) void loadConnections(true);
  };
  const searchProviders = (text: string) => {
    if (!alive || !active() || page() !== 'providers') return;
    providerQuery.set(text);
    if (text.trim() && providerNext() !== null) void loadProviders(true);
  };
  const newConnection = () => {
    if (busy()) return;
    editor.set(null);
    discovery.set('idle');
    model.set(null);
    modelQuery.set('');
    error.set('');
    notice.set('');
    confirmation.set(null);
    cancelRead();
    page.set('providers');
    void loadProviders();
  };
  const chooseProvider = async (identity: SettingsProviderSummary['identity']) => {
    if (!alive || !active() || busy() || page() !== 'providers') return;
    const generation = ++read;
    loading.set(true);
    error.set('');
    try {
      const provider: SettingsProvider = await host.query('authentication', 'provider', identity);
      if (!alive || !active() || generation !== read) return;
      if (
        !provider.descriptor.anonymous &&
        !provider.descriptor.authentication.some(
          (method) => (method.id === 'api-key' && !method.interactive) || method.interactive,
        )
      )
        throw new UiError(
          'This provider does not offer an API key or interactive sign-in supported here.',
        );
      const configuration = provider.descriptor.configurationDefaults as Record<
        string,
        unknown
      > | null;
      const slug =
        provider.identity.name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'connection';
      editor.set({
        instance: ++editorInstance,
        baseline: null,
        provider,
        name: provider.descriptor.label,
        slug,
        enabled: true,
        overlay: 'null',
        apiKey: '',
        baseUrl: typeof configuration?.baseUrl === 'string' ? configuration.baseUrl : '',
      });
      credential.set(null);
      discovery.set('idle');
      page.set('connection');
    } catch (reason) {
      if (generation === read) report(reason);
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const readDetail = async (target: ConnectionVersionBasis, afterCredential = false) => {
    let detail: SettingsConnectionDetail = await host.query('settings', 'connection', {
      ...target,
      includeEditingFacts: true,
    });
    if (
      afterCredential &&
      detail.kind === 'stale' &&
      detail.actual?.connectionId === target.connectionId
    ) {
      detail = await host.query('settings', 'connection', {
        ...detail.actual,
        includeEditingFacts: true,
      });
    }
    if (detail.kind !== 'ready') throw rejection({ kind: 'connection_stale' });
    if (!detail.editing)
      throw new UiError('Editable connection facts are unavailable. Editing is disabled.');
    return detail;
  };
  const readCredential = async (detail: Detail) => {
    const result = await host.query('settings', 'credentialStatus', {
      locator: {
        scope: 'connection',
        connectionId: detail.target.connectionId,
        kind: 'provider',
      },
    });
    if (result.kind !== 'status') throw new UiError('This connection is no longer available.');
    return result.status as CredentialStatus;
  };
  const openConnection = async (target: ConnectionVersionBasis) => {
    if (!alive || !active() || busy() || page() !== 'connections') return;
    const generation = ++read;
    loading.set(true);
    error.set('');
    notice.set('');
    editor.set(null);
    discovery.set('idle');
    model.set(null);
    modelQuery.set('');
    page.set('connections');
    try {
      const detail = await readDetail(target);
      const [provider, status] = await Promise.all([
        host.query('authentication', 'provider', detail.target.provider),
        readCredential(detail),
      ]);
      if (!alive || !active() || generation !== read) return;
      editor.set({
        instance: ++editorInstance,
        baseline: detail,
        provider,
        name: detail.name,
        slug: detail.target.slug,
        enabled: detail.enabled,
        baseUrl:
          typeof detail.target.configuration.baseUrl === 'string'
            ? detail.target.configuration.baseUrl
            : '',
        overlay: pretty(detail.editing!.requestBodyOverlay),
        apiKey: '',
      });
      credential.set(status);
      model.set(null);
      confirmation.set(null);
      page.set('connection');
    } catch (reason) {
      if (generation === read) report(reason);
    } finally {
      if (alive && generation === read) loading.set(false);
    }
  };
  const edit = (field: 'name' | 'slug' | 'baseUrl' | 'overlay' | 'apiKey', text: string) => {
    const current = editor();
    if (!current || busy()) return;
    editor.set({ ...current, [field]: text });
  };
  const configuration = (form: ConnectionEditor) => {
    const value = {
      ...(form.baseline?.target.configuration ??
        (form.provider.descriptor.configurationDefaults as Record<string, unknown>)),
    };
    if ('baseUrl' in value || form.baseUrl) value.baseUrl = form.baseUrl;
    return value;
  };
  const dirty = () => {
    const form = editor();
    if (!form?.baseline) return !!form;
    try {
      return (
        !!form.apiKey ||
        form.name !== form.baseline.name ||
        form.enabled !== form.baseline.enabled ||
        JSON.stringify(configuration(form)) !==
          JSON.stringify(form.baseline.target.configuration) ||
        JSON.stringify(overlay(form.overlay)) !==
          JSON.stringify(form.baseline.editing!.requestBodyOverlay)
      );
    } catch {
      return true;
    }
  };
  const adopt = async (
    target: ConnectionVersionBasis,
    captured: number,
    key: 'unchanged' | 'committed' | 'refresh' = 'refresh',
  ) => {
    changed();
    let detail: Detail;
    try {
      detail = await readDetail(target, key === 'committed');
    } catch (reason) {
      if (alive && editor()?.instance === captured) {
        editor.set(null);
        model.set(null);
        page.set('connections');
        notice.set(
          message(
            'The change was committed. Its editable snapshot could not be reopened; no further changes can be saved here.',
          ),
        );
      }
      throw reason;
    }
    if (!alive || editor()?.instance !== captured) return null;
    // Advance the basis before the independent credential stage. A key failure
    // must retry this existing connection, never create another one.
    editor.set({
      ...editor()!,
      baseline: detail,
      name: detail.name,
      slug: detail.target.slug,
      enabled: detail.enabled,
      overlay: pretty(detail.editing!.requestBodyOverlay),
      baseUrl:
        typeof detail.target.configuration.baseUrl === 'string'
          ? detail.target.configuration.baseUrl
          : '',
    });
    if (key !== 'unchanged') {
      const status = await readCredential(detail);
      if (!alive || editor()?.instance !== captured) return null;
      credential.set(status);
    }
    return detail;
  };
  const saveConnection = (request: ConnectionAction) => {
    if (!current(request)) return;
    return run(async () => {
      const form = editor();
      if (!form) return;
      if (!form.name.trim()) throw new UiError('Enter a connection name.');
      const body = overlay(form.overlay);
      const config = configuration(form);
      const refreshModels =
        !form.baseline ||
        !!form.apiKey ||
        JSON.stringify(config) !== JSON.stringify(form.baseline.target.configuration);
      let result: CatalogMutationResult | null = null;
      const original = form.baseline;
      const expectedCredential = credentialBasis(credential());
      if (!original) {
        if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(form.slug))
          throw new UiError(
            'Use lowercase letters, numbers, dashes or underscores for the connection ID.',
          );
        if (revision() === null)
          throw new UiError('Refresh the connection catalog before creating a connection.');
        result = await mutate('settings', 'create', {
          expectedCatalogRevision: revision(),
          connection: {
            slug: form.slug,
            name: form.name,
            provider: form.provider.identity,
            configuration: config,
            enabled: form.enabled,
            enabledModelIds: [],
            ...(body === null ? {} : { requestBodyOverlay: body }),
          },
        });
      } else {
        const changes: Record<string, unknown> = {};
        if (form.name !== original.name) changes.name = form.name;
        if (form.enabled !== original.enabled) changes.enabled = form.enabled;
        if (JSON.stringify(config) !== JSON.stringify(original.target.configuration)) {
          changes.configuration = config;
          // A connection endpoint change resets discovery in Host. Preserve the
          // explicit per-model choices from the exact editing baseline.
          changes.modelOverrides = original.editing!.modelOverrides;
        }
        if (JSON.stringify(body) !== JSON.stringify(original.editing!.requestBodyOverlay))
          changes.requestBodyOverlay = body;
        if (Object.keys(changes).length)
          result = await mutate('settings', 'update', {
            expected: basis(original),
            changes,
          });
      }
      let detail = original;
      if (result) {
        if (result.kind !== 'committed' || !result.connection) throw rejection(result);
        detail = await adopt(
          result.connection,
          form.instance,
          form.apiKey ? 'unchanged' : 'refresh',
        );
        if (!detail) return;
        notice.set(message('Connection saved.'));
      }
      if (form.apiKey) {
        if (!alive || editor()?.instance !== form.instance) return;
        if (!detail) throw new UiError('Save the connection before saving its API key.');
        if (alive) notice.set(message('Connection saved; saving API key…'));
        const saved = await mutate(
          'settings',
          'saveCredential',
          {
            expected: detail.target,
            expectedCredential,
          },
          form.apiKey,
        );
        if (saved.kind !== 'saved') throw rejection(saved);
        if (!alive || editor()?.instance !== form.instance) return;
        editor.set({ ...editor()!, apiKey: '' });
        // Reauthentication advances the connection revision independently.
        // Read the actual new basis; never guess a revision or reuse the old one.
        if (!(await adopt(basis(detail), form.instance, 'committed'))) return;
        notice.set(message('Connection and API key saved.'));
        changed();
      } else if (alive && !result) notice.set(message('No connection changes.'));
      await loadConnections();
      if (refreshModels) await discoverSavedConnection(form.instance);
    });
  };
  const login = createConnectionLogin(operations, {
    accepts(request: LoginAction) {
      const form = editor();
      return !!(
        form?.baseline &&
        current({
          editor: request.editor,
          revision: request.input.expected.revision,
        }) &&
        form.baseline.target.connectionId === request.input.expected.connectionId &&
        JSON.stringify(credentialBasis(credential())) ===
          JSON.stringify(request.input.expectedCredential) &&
        form.provider.descriptor.authentication.some(
          (method) => method.interactive && method.id === request.input.method,
        ) &&
        !dirty()
      );
    },
    async saved(request, result) {
      const target = request.input.expected;
      if (
        result.connection.connectionId !== target.connectionId ||
        result.connection.slug !== target.slug ||
        JSON.stringify(result.connection.provider) !== JSON.stringify(target.provider)
      )
        throw new UiError(
          'The sign-in receipt refers to another connection. Reload before continuing.',
        );
      if (
        !alive ||
        editor()?.instance !== request.editor ||
        editor()?.baseline?.target.revision !== target.revision
      )
        return;
      await adopt(
        { connectionId: target.connectionId, revision: target.revision },
        request.editor,
        'committed',
      );
    },
    async discover(request) {
      await discoverSavedConnection(request.editor);
    },
  });
  const loginAction = (method: string): LoginAction => ({
    editor: editor()!.instance,
    input: {
      expected: editor()!.baseline!.target,
      expectedCredential: credentialBasis(credential()),
      method,
    },
  });
  const toggleEnabled = (request: ConnectionAction & { enabled: boolean }) => {
    const form = editor();
    if (current(request) && form && !busy()) editor.set({ ...form, enabled: request.enabled });
  };
  const fetchModels = async (form: ConnectionEditor & { baseline: Detail }) => {
    discovery.set('fetching');
    try {
      const result = await mutate('setup', 'discoverModels', form.baseline.target);
      if (result.kind === 'failed')
        throw new UiError(
          'Could not fetch models. Check the provider credential, endpoint and network, or add a model manually.',
        );
      if (result.kind !== 'ready') throw rejection(result);
      await adopt(result.connection, form.instance);
      if (!alive || editor()?.instance !== form.instance) return;
      discovery.set('ready');
      await loadConnections();
    } catch (reason) {
      if (alive && editor()?.instance === form.instance) discovery.set('failed');
      throw reason;
    }
  };
  const discoverSavedConnection = async (instance: number) => {
    const form = editor();
    if (
      !alive ||
      form?.instance !== instance ||
      !form.baseline ||
      !form.provider.descriptor.discovery ||
      (!form.provider.descriptor.anonymous && !credential()?.configured)
    )
      return;
    await fetchModels({ ...form, baseline: form.baseline });
  };
  const discover = (request: ConnectionAction) => {
    if (!current(request)) return;
    return run(async () => {
      const form = editor();
      if (!form?.baseline || dirty())
        throw new UiError('Save the connection changes before fetching models.');
      if (!form.provider.descriptor.anonymous && !credential()?.configured)
        throw new UiError('Add an API key or finish provider sign-in before fetching models.');
      await fetchModels({ ...form, baseline: form.baseline });
      if (alive) notice.set(message('Models fetched and enabled.'));
    });
  };
  const editModel = (request: ConnectionAction & { id: string | null }) => {
    if (!current(request)) return;
    const id = request.id;
    const form = editor();
    if (busy() || !form?.baseline?.editing) return;
    if (dirty()) {
      error.set(message('Save or discard the connection changes before editing models.'));
      return;
    }
    const raw = id ? form.baseline.editing.modelOverrides?.[id] : undefined;
    model.set({
      originalId: id,
      id: id ?? '',
      label: raw?.displayName ?? '',
      limits: {
        contextWindow: raw?.contextWindow?.toString() ?? '',
        inputLimit: raw?.inputLimit?.toString() ?? '',
        maxOutputTokens: raw?.maxOutputTokens?.toString() ?? '',
        compactionThreshold: raw?.compactionThreshold?.toString() ?? '',
      },
      codeMode: raw?.codeMode ?? null,
      codeModeLanguage: raw?.codeModeLanguage ?? null,
      applyPatch: raw?.applyPatch ?? null,
      thinkingLevels: raw?.thinkingLevels ? [...raw.thinkingLevels] : null,
      defaultThinkingLevel: raw?.defaultThinkingLevel ?? null,
      defaults: null,
      effective: null,
    });
    confirmation.set(null);
    page.set('model');
    error.set('');
    notice.set('');
    void loadModelMetadata({ ...modelAction() });
  };
  const modelOverride = (
    current: ModelEditor,
  ):
    | { kind: 'valid'; value: ModelOverride }
    | { kind: 'invalid'; field: (typeof modelLimitFields)[number]['label'] } => {
    const id = current.id.trim();
    const value: ModelOverride = {
      ...(editor()?.baseline?.editing?.modelOverrides?.[id] ?? {}),
    };
    if (current.label) value.displayName = current.label;
    else delete value.displayName;
    if (current.thinkingLevels === null) delete value.thinkingLevels;
    else value.thinkingLevels = current.thinkingLevels;
    if (current.defaultThinkingLevel) value.defaultThinkingLevel = current.defaultThinkingLevel;
    else delete value.defaultThinkingLevel;
    if (current.codeMode === null) delete value.codeMode;
    else value.codeMode = current.codeMode;
    if (current.codeModeLanguage === null) delete value.codeModeLanguage;
    else value.codeModeLanguage = current.codeModeLanguage;
    if (current.applyPatch === null) delete value.applyPatch;
    else value.applyPatch = current.applyPatch;
    for (const { key, label } of modelLimitFields) {
      const text = current.limits[key].trim();
      if (!text) delete value[key];
      else {
        const tokens = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(tokens) || tokens <= 0)
          return { kind: 'invalid', field: label };
        value[key] = tokens;
      }
    }
    return { kind: 'valid', value };
  };
  const loadModelMetadata = async (request: ModelAction) => {
    const connectionId = editor()!.baseline!.target.connectionId;
    const generation = ++read;
    const current = model()!;
    const parsed = modelOverride(current);
    modelLoading.set(false);
    if (!request.modelId.trim() || parsed.kind === 'invalid') return;
    modelLoading.set(true);
    try {
      const result = await host.query('settings', 'resolveModel', {
        connectionId,
        modelId: request.modelId.trim(),
        overrides: parsed.value,
      });
      if (generation !== read || !currentModel(request)) return;
      if (
        result.kind !== 'ready' ||
        result.choice.selection.connectionId !== connectionId ||
        result.choice.selection.modelId !== request.modelId.trim() ||
        result.choice.selection.revision !== request.revision
      )
        return;
      model.set({
        ...model()!,
        defaults: result.defaults,
        effective: {
          thinkingLevels: [...result.choice.thinkingLevels],
          defaultThinkingLevel: result.choice.defaultThinkingLevel,
          limits: result.choice.limits ?? null,
        },
      });
    } catch (reason) {
      if (generation === read && currentModel(request)) report(reason);
    } finally {
      if (alive && generation === read) modelLoading.set(false);
    }
  };
  const changeModel = (change: Partial<ModelEditor>) => {
    const current = model();
    if (current && !busy()) {
      const refresh =
        change.id !== undefined ||
        change.thinkingLevels !== undefined ||
        change.defaultThinkingLevel !== undefined ||
        change.limits !== undefined;
      model.set({
        ...current,
        ...change,
        defaults: refresh ? null : current.defaults,
        effective: change.id !== undefined && change.id !== current.id ? null : current.effective,
      });
      if (refresh) void loadModelMetadata(modelAction());
    }
  };
  const toggleThinking = (request: ModelAction & { level: ThinkingLevel }) => {
    if (!currentModel(request)) return;
    const level = request.level;
    const current = model();
    if (!current || busy()) return;
    const effective = current.thinkingLevels ?? current.effective?.thinkingLevels ?? [];
    const levels = effective.includes(level)
      ? effective.filter((value) => value !== level)
      : [...effective, level];
    changeModel({
      thinkingLevels: levels,
      defaultThinkingLevel:
        current.defaultThinkingLevel && levels.includes(current.defaultThinkingLevel)
          ? current.defaultThinkingLevel
          : null,
    });
  };
  const useProviderThinking = (request: ModelAction) => {
    if (currentModel(request)) changeModel({ thinkingLevels: null, defaultThinkingLevel: null });
  };
  const defaultThinking = (request: ModelAction & { level: ThinkingLevel | null }) => {
    if (
      currentModel(request) &&
      (request.level === null ||
        (model()?.thinkingLevels ?? model()?.effective?.thinkingLevels)?.includes(request.level))
    )
      changeModel({ defaultThinkingLevel: request.level });
  };
  const changeTool = (
    request: ModelAction & {
      tool: 'codeMode' | 'applyPatch';
      enabled: boolean | null;
    },
  ) => {
    if (currentModel(request)) changeModel({ [request.tool]: request.enabled });
  };
  const changeCodeLanguage = (request: ModelAction & { language: CodeLanguage }) => {
    if (currentModel(request)) changeModel({ codeModeLanguage: request.language });
  };
  const showModels = (request: ConnectionAction) => {
    if (current(request) && !busy() && !dirty() && editor()?.baseline) {
      page.set('models');
      error.set('');
    }
  };
  const saveModel = (request: ModelAction) => {
    if (!currentModel(request)) return;
    return run(async () => {
      const form = editor(),
        current = model();
      if (!form?.baseline?.editing || !current) return;
      if (dirty())
        throw new UiError('Save or discard the connection changes before editing models.');
      const id = current.id.trim();
      if (!id) throw new UiError('Enter the exact model ID accepted by the provider.');
      const facts = form.baseline.editing;
      if (current.originalId === null && facts.enabledModelIds.includes(id))
        throw new UiError('That model is already enabled.');
      const overrides = { ...(facts.modelOverrides ?? {}) };
      const parsed = modelOverride(current);
      if (parsed.kind === 'invalid')
        throw new UiError('{field} must be a positive whole number of tokens.', {
          field: message(parsed.field),
        });
      overrides[id] = parsed.value;
      const result = await mutate('settings', 'update', {
        expected: basis(form.baseline),
        changes: {
          enabledModelIds: facts.enabledModelIds.includes(id)
            ? facts.enabledModelIds
            : [...facts.enabledModelIds, id],
          modelOverrides: overrides,
        },
      });
      if (result.kind !== 'committed' || !result.connection) throw rejection(result);
      await adopt(result.connection, form.instance);
      await loadConnections();
      if (alive) {
        model.set(null);
        page.set('models');
        notice.set(message('Model saved.'));
      }
    });
  };
  const setDefault = (request: ConnectionAction & { id: string | null }) => {
    if (!current(request)) return;
    const id = request.id;
    return run(async () => {
      const form = editor();
      if (!form?.baseline || revision() === null) return;
      const result = await mutate('settings', 'setDefault', {
        expectedCatalogRevision: revision(),
        target:
          id === null ? null : { connectionId: form.baseline.target.connectionId, modelId: id },
      });
      if (result.kind !== 'committed') throw rejection(result);
      await loadConnections();
      changed();
      if (alive)
        notice.set(id ? message('Default model saved.') : message('Default model cleared.'));
    });
  };
  const confirm = (request: RemovalAction) => {
    if (
      current(request) &&
      !busy() &&
      (request.kind !== 'model' || model()?.originalId === request.modelId) &&
      (request.kind !== 'key' || !dirty())
    )
      confirmation.set(request.kind);
  };
  const removalAction = (): RemovalAction => ({
    ...action(),
    kind: confirmation()!,
    modelId: model()?.originalId ?? null,
  });
  const remove = (request: RemovalAction) => {
    if (
      !current(request) ||
      confirmation() !== request.kind ||
      (request.kind === 'model' && model()?.originalId !== request.modelId) ||
      (request.kind === 'key' && dirty())
    )
      return;
    return run(async () => {
      const form = editor();
      if (!form?.baseline) return;
      const kind = confirmation();
      confirmation.set(null);
      if (kind === 'connection') {
        const result = await mutate('settings', 'remove', {
          expected: basis(form.baseline),
        });
        if (result.kind !== 'committed') throw rejection(result);
        if (alive) {
          editor.set(null);
          model.set(null);
          page.set('connections');
          notice.set(message('Connection removed.'));
        }
      } else if (kind === 'key') {
        const expected = credentialBasis(credential());
        if (!expected) return;
        const result = await mutate('settings', 'deleteCredential', {
          expected,
          expectedConnection: form.baseline.target,
        });
        if (result.kind !== 'committed') throw rejection(result);
        if (!(await adopt(basis(form.baseline), form.instance, 'committed'))) return;
        if (alive) notice.set(message('Stored provider credential removed.'));
      } else if (kind === 'model') {
        const current = model();
        if (!current?.originalId) return;
        const facts = form.baseline.editing!;
        const overrides = { ...(facts.modelOverrides ?? {}) };
        delete overrides[current.originalId];
        const result = await mutate('settings', 'update', {
          expected: basis(form.baseline),
          changes: {
            enabledModelIds: facts.enabledModelIds.filter(
              (id: string) => id !== current.originalId,
            ),
            modelOverrides: overrides,
          },
        });
        if (result.kind !== 'committed' || !result.connection) throw rejection(result);
        await adopt(result.connection, form.instance);
        if (alive) {
          model.set(null);
          page.set('models');
          notice.set(message('Model removed from this connection.'));
        }
      }
      await loadConnections();
      changed();
    });
  };
  const back = () => {
    if (busy()) return false;
    if (confirmation()) {
      confirmation.set(null);
      return false;
    }
    if (page() === 'model') {
      model.set(null);
      page.set('models');
      return false;
    }
    if (page() === 'models') {
      page.set('connection');
      return false;
    }
    if (page() !== 'connections') {
      cancelRead();
      editor.set(null);
      confirmation.set(null);
      page.set('connections');
      void loadConnections();
      return false;
    }
    return true;
  };
  const deactivate = () => {
    cancelRead();
    if (editor()) editor.set({ ...editor()!, instance: ++editorInstance });
  };
  const activate = () => {
    if (page() === 'connections') void loadConnections();
    else if (page() === 'providers') void loadProviders();
    else if (page() === 'model') void loadModelMetadata(modelAction());
  };
  const reset = () => {
    cancelRead();
    editor.set(null);
    model.set(null);
    confirmation.set(null);
    page.set('connections');
    if (active()) void loadConnections();
  };
  const openInitialModel = async (target: ModelSelection) => {
    const catalogRead = read + 1;
    await loadConnections();
    if (!alive || !active() || catalogRead !== read || page() !== 'connections') return;
    const generation = read + 1;
    await openConnection({
      connectionId: target.connectionId,
      revision: target.revision,
    });
    if (
      !alive ||
      !active() ||
      generation !== read ||
      page() !== 'connection' ||
      editor()?.baseline?.target.connectionId !== target.connectionId ||
      editor()?.baseline?.target.revision !== target.revision
    )
      return;
    editModel({ ...action(), id: target.modelId });
  };
  if (active()) {
    if (initialModel) void openInitialModel(initialModel);
    else activate();
  }
  return {
    page,
    connections,
    providers,
    connectionQuery,
    providerQuery,
    modelQuery,
    filteredConnections,
    filteredProviders,
    filteredModels,
    searchConnections,
    searchProviders,
    revision,
    defaultTarget,
    editor,
    model,
    modelLoading,
    credential,
    loading,
    discovery,
    busy,
    error,
    notice,
    pending,
    pendingKnown,
    confirmation,
    dirty,
    action,
    login,
    loginAction,
    editableBaseUrl: () =>
      !!editor()?.provider.descriptor.customEndpoint || 'baseUrl' in configuration(editor()!),
    modelAction,
    removalAction,
    loadConnections,
    loadProviders,
    newConnection,
    chooseProvider,
    openConnection,
    edit,
    saveConnection,
    toggleEnabled,
    discover,
    editModel,
    changeModel,
    toggleThinking,
    useProviderThinking,
    defaultThinking,
    changeTool,
    changeCodeLanguage,
    showModels,
    saveModel,
    setDefault,
    confirm,
    remove,
    cancelRemoval(request: RemovalAction) {
      if (
        current(request) &&
        !busy() &&
        confirmation() === request.kind &&
        (request.kind !== 'model' || model()?.originalId === request.modelId)
      )
        confirmation.set(null);
    },
    navigation: () =>
      JSON.stringify([
        page(),
        editor()?.instance,
        editor()?.baseline?.target.revision,
        model()?.originalId,
        model()?.id,
        confirmation(),
      ]),
    activate,
    deactivate,
    reset,
    back,
  };
}
export type ModelSettingsOwner = ReturnType<typeof createModelSettings>;
