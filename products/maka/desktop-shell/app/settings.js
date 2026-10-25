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

// Settings: the language and appearance, model connections, their API keys,
// the default model, WorkHub's
// subagents (subagents.js) and the archived tasks (archived.js). The calls
// follow the TUI's settings
// plugins (plugins/settings/connection-form/operations.ts and
// plugins/settings/credential/index.ts): create the connection, save its key
// as the `secret` resource of `settings.saveCredential`, then let
// `setup.discoverModels` find and enable its models.
//
// A key lives only in the masked input and is never logged.

import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Button } from 'gpui-base';
import { query, operation, log } from './host.js';
import { Subagents, subagentsActions, subagentsStatus, subagentsSection } from './subagents.js';
import { Archived, archivedStatus, archivedSection } from './archived.js';
import {
  palette,
  typeset,
  text,
  icon,
  pill,
  ghostButton,
  controlButton,
  textField,
  APPEARANCES,
  appearancePreference,
  setAppearancePreference,
} from './theme.js';
import {
  LANGUAGE_CHOICES,
  LANGUAGE_NAMES,
  applyLanguage,
  onLanguageChange,
  t,
  tn,
} from './locale.js';

/** A control button in the settings' style: primary or outline. */
export function button(id, label, primary, disabled, cx) {
  return controlButton(id, label, primary ? 'primary' : 'outline', disabled, cx);
}

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_PAGES = 32;
/** Providers listed at once while choosing one. */
const PROVIDER_ROWS = 12;

/** Why the Host did not save a key, by its reason: the message's key. */
const KEY_REJECTIONS = {
  invalid_input: 'keyRejectedRequest',
  invalid_secret: 'keyRejectedSecret',
  secret_unavailable: 'keyRejectedUnreadable',
  provider_unavailable: 'keyRejectedProvider',
  authentication_unavailable: 'keyRejectedNoKeys',
  attempt_conflict: 'keyRejectedConflict',
  connection_changed: 'connectionChanged',
  credential_changed: 'keyRejectedKeyChanged',
  capacity: 'keyRejectedFull',
  slug_taken: 'keyRejectedIdTaken',
  authentication: 'keyRejectedAuthentication',
};

export class Settings {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, report: (message: string) => void, modelsChanged: () => void,
   *   presetsChanged: (snapshot: object) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.open = false;
    /** The page shown: "general", "models", "connections", "subagents" or "archived". */
    this.page = 'general';
    /** The Host's confirmed assistant preferences, including their shared revision. */
    this.preferences = null;
    /** The connection catalog's revision, which every catalog change names. */
    this.revision = null;
    this.defaultTarget = null;
    this.connections = [];
    /** connectionId -> its credential status, or null when it could not be read. */
    this.statuses = new Map();
    /** Provider name -> its descriptor (`authentication.provider`). */
    this.descriptors = new Map();
    /** Every provider the Host offers, once listed: { identity, label, authentication }. */
    this.providers = null;
    this.models = { revision: null, choices: [], defaultModel: { kind: 'none' }, next: null };
    this.modelReads = 0;
    this.loading = false;
    /** What is running, shown instead of the actions; one change at a time. */
    this.busy = null;
    this.error = null;
    /** connectionId -> what the last change did to it. */
    this.notes = new Map();
    /** { kind: 'add', provider, descriptor } or { kind: 'key', connectionId }, or null. */
    this.form = null;
    /** The connection whose removal waits for a confirmation, if any. */
    this.removing = null;
    /** The Subagents page, read each time it shows. */
    this.subagents = new Subagents(hooks);
    /** The Archived page, read each time it shows. */
    this.archived = new Archived(hooks);

    this.modelQuery = InputState.new({ placeholder: t('findModel') });
    this.modelQuery.on('change', () => this.loadModels());
    this.providerQuery = InputState.new({ placeholder: t('findProvider') });
    this.providerQuery.on('change', () => this.hooks.changed());
    this.name = InputState.new({ placeholder: t('fieldName') });
    this.endpoint = InputState.new({ placeholder: t('endpointUrl') });
    this.key = InputState.new({ placeholder: t('apiKey') });
    this.key.set_masked(true);
    // The inputs live as long as the app, so their placeholders follow the
    // language for good.
    onLanguageChange(() => {
      this.modelQuery.set_placeholder(t('findModel'));
      this.providerQuery.set_placeholder(t('findProvider'));
      this.name.set_placeholder(t('fieldName'));
      this.endpoint.set_placeholder(t('endpointUrl'));
      this.key.set_placeholder(t('apiKey'));
    });
  }

  show(page = null) {
    if (page !== null) this.page = page;
    this.open = true;
    this.load();
    if (this.page === 'subagents') this.subagents.load();
    if (this.page === 'archived') this.archived.load();
    this.hooks.changed();
  }

  showPage(page) {
    if (this.page === page) return;
    this.page = page;
    if (page === 'subagents') this.subagents.load();
    if (page === 'archived') this.archived.load();
    this.hooks.changed();
  }

  hide() {
    this.open = false;
    this.removing = null;
    this.closeForm();
    this.subagents.close();
    this.archived.close();
    this.hooks.changed();
  }

  async load() {
    this.loading = true;
    this.error = null;
    this.hooks.changed();
    try {
      await Promise.all([this.loadPreferences(), this.loadConnections()]);
      await Promise.all([this.loadStatuses(), this.loadDescriptors(), this.loadModels()]);
    } catch (error) {
      this.fail(t('settingsFailed', { value: error.message }));
    } finally {
      this.loading = false;
      this.hooks.changed();
    }
  }

  async loadPreferences() {
    const snapshot = await query('settings', 'assistantPreferences', {});
    // A delayed startup/open read must not undo a newer confirmed save.
    if (this.preferences === null || snapshot.revision >= this.preferences.revision) {
      this.preferences = snapshot;
      applyLanguage(snapshot.resolvedLanguage);
      this.hooks.changed();
    }
  }

  setLanguage(preference) {
    if (this.preferences === null) return;
    return this.run(
      t('savingLanguage'),
      (value) => t('settingsFailed', { value }),
      async () => {
        const result = await operation('settings', 'updateAssistantPreferences', {
          expectedRevision: this.preferences.revision,
          mutation: { kind: 'language', preference },
        });
        if (result.kind === 'revision_conflict') {
          await this.loadPreferences();
          throw new Error(t('languageChanged'));
        }
        if (result.kind !== 'committed') throw new Error(t('languageRejected'));
        // The receipt contains a revision, not a resolved language. Read the
        // actual snapshot, including any newer edit, before changing the UI.
        await this.loadPreferences();
      },
    );
  }

  /** Reads every page of the connection catalog at one revision. */
  async loadConnections() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await query('settings', 'connections', { kind: 'start' });
      if (first.kind !== 'ready') continue;
      const rows = [...first.connections];
      let next = first.next;
      let complete = true;
      for (let pages = 1; next !== null && next !== undefined; pages += 1) {
        if (pages >= MAX_PAGES) throw new Error(t('connectionListTooManyPages'));
        const page = await query('settings', 'connections', {
          kind: 'continue',
          revision: first.revision,
          offset: next,
        });
        if (page.kind !== 'ready') {
          complete = false;
          break;
        }
        rows.push(...page.connections);
        next = page.next;
      }
      if (!complete) continue;
      this.revision = first.revision;
      this.defaultTarget = first.defaultTarget ?? null;
      this.connections = rows;
      return;
    }
    throw new Error(t('connectionListKeptChanging'));
  }

  async loadStatuses() {
    await Promise.all(
      this.connections.map(async (connection) => {
        const id = connection.basis.connectionId;
        try {
          const result = await query('settings', 'credentialStatus', { locator: locator(id) });
          this.statuses.set(id, result.kind === 'status' ? result.status : null);
        } catch {
          this.statuses.set(id, null);
        }
      }),
    );
  }

  async loadDescriptors() {
    const names = new Set(this.connections.map((connection) => connection.provider.name));
    await Promise.all(
      [...names]
        .filter((name) => !this.descriptors.has(name))
        .map((name) =>
          this.descriptor(this.connections.find((c) => c.provider.name === name).provider).catch(
            () => null,
          ),
        ),
    );
  }

  /** The provider's descriptor, read once. */
  async descriptor(identity) {
    const known = this.descriptors.get(identity.name);
    if (known) return known;
    const provider = await query('authentication', 'provider', identity);
    if (!provider?.descriptor) throw new Error(t('noProviderDescription', { name: identity.name }));
    this.descriptors.set(identity.name, provider.descriptor);
    return provider.descriptor;
  }

  async loadProviders() {
    const providers = [];
    for (let offset = 0, pages = 0; offset !== null && offset !== undefined; pages += 1) {
      if (pages >= MAX_PAGES) throw new Error(t('providerListTooManyPages'));
      const page = await query('settings', 'providers', { offset });
      providers.push(...page.providers);
      offset = page.next;
    }
    this.providers = providers;
  }

  /** The first page of models matching the search; a later search wins over an earlier one. */
  async loadModels() {
    const read = ++this.modelReads;
    try {
      const search = this.modelQuery.value().trim();
      let page = await query('settings', 'models', { kind: 'start', query: search });
      if (page.kind !== 'ready')
        page = await query('settings', 'models', { kind: 'start', query: search });
      if (read !== this.modelReads) return;
      if (page.kind !== 'ready') throw new Error(t('modelListKeptChanging'));
      this.models = {
        revision: page.revision,
        choices: page.choices,
        defaultModel: page.defaultModel,
        next: page.next ?? null,
      };
    } catch (error) {
      if (read === this.modelReads) this.fail(t('modelsFailed', { value: error.message }));
    }
    this.hooks.changed();
  }

  async moreModels() {
    const { revision, next } = this.models;
    if (next === null) return;
    const read = ++this.modelReads;
    try {
      const page = await query('settings', 'models', { kind: 'continue', revision, cursor: next });
      if (read !== this.modelReads) return;
      if (page.kind !== 'ready') return this.loadModels();
      this.models = {
        ...this.models,
        choices: [...this.models.choices, ...page.choices],
        next: page.next ?? null,
      };
    } catch (error) {
      if (read === this.modelReads) this.fail(t('modelsFailed', { value: error.message }));
    }
    this.hooks.changed();
  }

  /**
   * Runs one change at a time; its failure is shown on the page and in the
   * status line, as `failure` words it from the error's message.
   * @param {string} label
   * @param {(value: string) => string} failure
   */
  async run(label, failure, work) {
    if (this.busy !== null) return;
    this.busy = label;
    this.error = null;
    this.hooks.changed();
    try {
      await work();
    } catch (error) {
      this.fail(failure(error.message));
    } finally {
      this.busy = null;
      this.hooks.changed();
    }
  }

  fail(message) {
    this.error = message;
    this.hooks.report(this.error);
  }

  setDefault(choice) {
    const failure = (value) => t('settingDefaultFailed', { value });
    return this.run(t('settingDefault'), failure, async () => {
      const target = {
        connectionId: choice.selection.connectionId,
        modelId: choice.selection.modelId,
      };
      const result = await this.catalogChange('setDefault', (revision) => ({
        expectedCatalogRevision: revision,
        target,
      }));
      log(`settings: setDefault ${result.kind}`);
      await this.loadConnections();
      await this.loadModels();
      this.hooks.modelsChanged();
    });
  }

  /**
   * A catalog mutation at the current revision. A revision conflict means it
   * did not run, so it is sent once more at the new revision.
   */
  async catalogChange(method, input) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await operation('settings', method, input(this.revision));
      if (result.kind === 'committed') {
        this.revision = result.catalogRevision;
        return result;
      }
      if (result.kind === 'revision_conflict' && attempt === 0) {
        await this.loadConnections();
        continue;
      }
      throw new Error(describeCatalog(result));
    }
  }

  openAdd() {
    if (this.busy !== null) return;
    this.form = { kind: 'add', provider: null, descriptor: null };
    this.providerQuery.set_value('');
    if (this.providers === null) {
      this.loadProviders().then(
        () => this.hooks.changed(),
        (error) => this.fail(t('providersFailed', { value: error.message })),
      );
    }
    this.hooks.changed();
  }

  async chooseProvider(provider) {
    const form = this.form;
    if (form?.kind !== 'add') return;
    try {
      const descriptor = await this.descriptor(provider.identity);
      if (this.form !== form) return;
      form.provider = provider;
      form.descriptor = descriptor;
      this.name.set_value(descriptor.label ?? provider.label);
      const defaults = isObject(descriptor.configurationDefaults)
        ? descriptor.configurationDefaults
        : {};
      this.endpoint.set_value(typeof defaults.baseUrl === 'string' ? defaults.baseUrl : '');
      this.key.set_value('');
    } catch (error) {
      this.fail(t('providerFailed', { value: error.message }));
    }
    this.hooks.changed();
  }

  openKey(connection) {
    if (this.busy !== null) return;
    this.form = { kind: 'key', connectionId: connection.basis.connectionId };
    this.key.set_value('');
    this.hooks.changed();
  }

  closeForm() {
    this.form = null;
    this.key.set_value('');
    this.hooks.changed();
  }

  addConnection() {
    const form = this.form;
    if (form?.kind !== 'add' || form.descriptor === null) return;
    const name = this.name.value().trim();
    const endpoint = this.endpoint.value().trim();
    const key = this.key.value().trim();
    const problem = checkConnection(form.descriptor, name, endpoint, key);
    if (problem !== null) {
      this.error = problem;
      this.hooks.changed();
      return;
    }
    const failure = (value) => t('addingConnectionFailed', { name, value });
    return this.run(t('addingConnection', { name }), failure, async () => {
      const outcome = await this.connect({
        provider: form.provider.identity,
        descriptor: form.descriptor,
        name,
        slug: this.freeSlug(name, form.provider.identity.name),
        endpoint,
        key,
      });
      this.notes.set(outcome.connectionId, outcome.note);
      this.closeForm();
    });
  }

  saveKey() {
    const form = this.form;
    if (form?.kind !== 'key') return;
    const key = this.key.value().trim();
    if (key === '') {
      this.error = t('enterApiKey');
      this.hooks.changed();
      return;
    }
    const failure = (value) => t('savingKeyFailed', { value });
    return this.run(t('savingKey'), failure, async () => {
      const id = form.connectionId;
      try {
        await this.storeKey(id, key);
        this.notes.set(id, t('keySavedThen', { value: await this.discover(id) }));
        this.closeForm();
      } finally {
        await this.loadStatuses();
      }
    });
  }

  /** Asks before removing a connection: its keys and default model go with it. */
  askRemove(connection) {
    if (this.busy !== null) return;
    this.removing = connection.basis.connectionId;
    this.hooks.changed();
  }

  cancelRemove() {
    this.removing = null;
    this.hooks.changed();
  }

  /**
   * Removes a connection at the revision shown, as the terminal app's
   * connection form does (settings.remove). The Host removes its keys and,
   * when it was the default, the default model; tasks that used it are kept.
   */
  removeConnection(connection) {
    const basis = connection.basis;
    const failure = (value) => t('removingConnectionFailed', { value });
    return this.run(t('removingConnection'), failure, async () => {
      this.removing = null;
      const result = await operation('settings', 'remove', {
        expected: { connectionId: basis.connectionId, revision: basis.revision },
      });
      if (result.kind !== 'committed') {
        // It changed meanwhile. The list is read again, so trying again
        // sends its current revision.
        await this.loadConnections();
        throw new Error(describeCatalog(result));
      }
      this.revision = result.catalogRevision;
      log(`settings: removed ${connection.slug}`);
      this.notes.delete(basis.connectionId);
      if (this.form?.connectionId === basis.connectionId) this.closeForm();
      await this.loadConnections();
      await this.loadModels();
      this.hooks.modelsChanged();
    });
  }

  findModels(connection) {
    const id = connection.basis.connectionId;
    const failure = (value) => t('findingModelsFailed', { value });
    return this.run(t('findingModels'), failure, async () => {
      this.notes.set(id, await this.discover(id));
    });
  }

  /**
   * Creates a connection, saves its key and finds its models. A key the
   * provider refuses leaves the connection in place without one, so the
   * error says so and Set key can retry.
   */
  async connect(spec) {
    const created = await this.catalogChange('create', (revision) => ({
      expectedCatalogRevision: revision,
      connection: {
        slug: spec.slug,
        name: spec.name,
        provider: spec.provider,
        configuration: configurationFor(spec.descriptor, spec.endpoint),
        enabled: true,
        enabledModelIds: [],
      },
    }));
    const connectionId = created.connection?.connectionId;
    if (!connectionId) throw new Error(t('hostCreatedNoConnection'));
    log(`settings: created ${spec.slug}`);
    await this.loadConnections();
    let note = t('added');
    if (spec.key) {
      try {
        await this.storeKey(connectionId, spec.key);
      } catch (error) {
        throw new Error(t('addedWithoutKey', { value: error.message }));
      } finally {
        await this.loadStatuses();
      }
      note = t('keySaved');
    }
    if (spec.descriptor.discovery) {
      const found = await this.discover(connectionId);
      note = spec.key ? t('keySavedThen', { value: found }) : t('addedThen', { value: found });
    }
    return { connectionId, note };
  }

  /** Saves `key` as the connection's API key, replacing the current one. */
  async storeKey(connectionId, key) {
    const target = await this.target(connectionId);
    const status = await query('settings', 'credentialStatus', { locator: locator(connectionId) });
    const current = status.kind === 'status' ? status.status : null;
    const expectedCredential =
      current?.configured && current.credentialId !== null && current.revision !== null
        ? {
            locator: current.locator,
            credentialId: current.credentialId,
            revision: current.revision,
          }
        : null;
    const result = await operation(
      'settings',
      'saveCredential',
      { expected: target, expectedCredential },
      { secret: key },
    );
    log(`settings: saveCredential ${target.slug} ${result.kind} ${result.reason ?? ''}`);
    if (result.kind !== 'saved') {
      const rejection = KEY_REJECTIONS[result.reason];
      throw new Error(
        rejection !== undefined ? t(rejection) : t('hostRefusedKey', { value: result.reason }),
      );
    }
  }

  /** Lets the Host find and enable the connection's models; answers what happened. */
  async discover(connectionId) {
    await this.loadConnections();
    const target = await this.target(connectionId);
    const result = await operation('setup', 'discoverModels', target);
    log(`settings: discoverModels ${target.slug} ${result.kind}`);
    await this.loadConnections();
    await this.loadModels();
    this.hooks.modelsChanged();
    if (result.kind === 'ready') {
      const count = this.find(connectionId)?.enabledModelCount ?? 0;
      return tn(count, 'modelsEnabledOne', 'modelsEnabledOther');
    }
    return result.kind === 'superseded' ? t('changedWhileFinding') : t('findingModelsFailedHint');
  }

  /** The connection as a credential target at its current revision. */
  async target(connectionId) {
    const connection = this.find(connectionId);
    if (!connection) throw new Error(t('connectionGone'));
    let detail = await query('settings', 'connection', connection.basis);
    if (detail.kind === 'stale' && detail.actual?.connectionId === connectionId) {
      detail = await query('settings', 'connection', detail.actual);
    }
    if (detail.kind !== 'ready') throw new Error(t('connectionChanged'));
    return detail.target;
  }

  find(connectionId) {
    return this.connections.find((c) => c.basis.connectionId === connectionId) ?? null;
  }

  /** A connection ID from the name that no connection uses yet. */
  freeSlug(name, fallback) {
    let base = slugOf(name);
    if (!SLUG.test(base)) base = slugOf(fallback);
    if (!SLUG.test(base)) base = 'connection';
    const taken = new Set(this.connections.map((c) => c.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    return slug;
  }
}

/** Why the add form cannot be sent, or null. */
function checkConnection(descriptor, name, endpoint, key) {
  if (name === '' || name.length > 256) return t('enterName');
  if (showsEndpoint(descriptor) && endpoint === '') return t('enterEndpoint');
  const auth = keyAuth(descriptor);
  if (auth === 'none') return t('providerSignsInTerminal');
  if (auth === 'required' && key === '') return t('enterApiKey');
  return null;
}

/**
 * How the provider takes an API key: 'required'; 'optional' (it also works
 * without one); 'unused' (it takes none and needs none, like a local
 * server); or 'none' (it signs in another way, which the desktop lacks).
 */
function keyAuth(descriptor) {
  const takesKey = (descriptor.authentication ?? []).some(
    (method) => method.id === 'api-key' && !method.interactive,
  );
  if (takesKey) return descriptor.anonymous ? 'optional' : 'required';
  return descriptor.anonymous ? 'unused' : 'none';
}

function takesKey(descriptor) {
  const auth = keyAuth(descriptor);
  return auth === 'required' || auth === 'optional';
}

function showsEndpoint(descriptor) {
  const defaults = isObject(descriptor.configurationDefaults)
    ? descriptor.configurationDefaults
    : {};
  return typeof defaults.baseUrl === 'string' || descriptor.customEndpoint === true;
}

/** The provider's default configuration, with the endpoint when it differs from the default. */
function configurationFor(descriptor, endpoint) {
  const defaults = isObject(descriptor.configurationDefaults)
    ? descriptor.configurationDefaults
    : {};
  if (endpoint === '') return { ...defaults };
  const trim = (url) => url.replace(/\/+$/, '');
  return typeof defaults.baseUrl === 'string' && trim(defaults.baseUrl) === trim(endpoint)
    ? { ...defaults }
    : { ...defaults, baseUrl: endpoint };
}

function describeCatalog(result) {
  switch (result.kind) {
    case 'connection_exists':
      return t('connectionIdExists', { slug: result.slug });
    case 'connection_stale':
      return t('connectionChanged');
    case 'revision_conflict':
      return t('settingsChanged');
    case 'invalid_default_target':
      return t('invalidDefaultModel');
    case 'rejected':
      return t('hostRefusedIt', { value: result.reason });
    default:
      return t('unexpectedAnswer', { value: result.kind });
  }
}

function locator(connectionId) {
  return { scope: 'connection', connectionId, kind: 'provider' };
}

function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function choiceLabel(choice) {
  return choice.connectionName ? `${choice.label} · ${choice.connectionName}` : choice.label;
}

/** The pages: id, the message keys of title and description, and icon. */
const PAGES = [
  ['general', 'settingsGeneral', 'settings', 'settingsGeneralDetail'],
  ['models', 'settingsModels', 'cpu', 'settingsModelsDetail'],
  ['connections', 'settingsConnections', 'tool-plug', 'settingsConnectionsDetail'],
  ['subagents', 'settingsSubagents', 'workhub', 'settingsSubagentsDetail'],
  ['archived', 'settingsArchived', 'archive', 'settingsArchivedDetail'],
];

/**
 * The settings navigation, in the sidebar's place: the column's height left
 * under the window strip (main.js).
 * @param {Settings} settings
 * @param {() => void} close
 */
export function settingsNav(settings, close, cx) {
  const m = palette(cx);
  return v_flex()
    .w(256)
    .flex_1()
    .min_h_0()
    .bg(m.canvas)
    .text_color(m.ink)
    .px(8)
    .pt(8)
    .gap(2)
    .child(
      typeset(ghostButton('settings-close', cx), 'body')
        .w_full()
        .h(32)
        .px(8)
        .gap(8)
        .justify_start()
        .on_click(close)
        .child(icon('chevron-left', 16, m.inkMuted))
        .child(t('backToApp')),
    )
    .child(
      typeset(div(), 'smallLabel')
        .h(28)
        .mt(8)
        .px(8)
        .flex()
        .items_center()
        .text_color(m.inkMuted)
        .font_weight(600)
        .child(t('settings')),
    )
    .children(
      PAGES.map(([page, label, glyph]) => {
        const selected = settings.page === page;
        return typeset(Button.new(`settings-page-${page}`), selected ? 'label' : 'body')
          .w_full()
          .h(32)
          .px(8)
          .gap(8)
          .items_center()
          .justify_start()
          .rounded(10)
          .text_color(m.ink)
          .when(selected, (el) => el.bg(m.selected))
          .when(!selected, (el) => el.hover((style) => style.bg(m.hover)))
          .on_click(() => settings.showPage(page))
          .child(icon(glyph, 16, m.inkMuted))
          .child(t(label));
      }),
    );
}

/**
 * The settings page in the plate.
 * @param {Settings} settings
 */
export function settingsPage(settings, cx) {
  const m = palette(cx);
  const busy = settings.busy !== null;
  const [, title, , description] = PAGES.find(([page]) => page === settings.page);
  // The Subagents and Archived pages read and save on their own, and say so
  // in their own lines.
  const subagents = settings.page === 'subagents';
  const archived = settings.page === 'archived';
  const loading = subagents
    ? settings.subagents.loading
    : archived
      ? settings.archived.loading
      : settings.loading;
  const actions = subagents ? subagentsActions(settings.subagents, cx) : null;
  const status = subagents
    ? subagentsStatus(settings.subagents, cx)
    : archived
      ? archivedStatus(settings.archived, cx)
      : null;
  return v_flex()
    .id('settings')
    .flex_1()
    .min_h_0()
    .overflow_y_scrollbar()
    .items_center()
    .px(24)
    .pt(32)
    .pb(48)
    .child(
      v_flex()
        .w_full()
        .max_w(920)
        .gap(32)
        .child(
          v_flex()
            .gap(6)
            .child(
              h_flex()
                .gap(12)
                .items_center()
                .child(text(t(title), 'display', m.ink).flex_1())
                .when(loading, (el) => el.child(text(t('loading'), 'small', m.inkMuted)))
                .when(settings.page === 'connections', (el) =>
                  el.child(
                    button('connection-add', t('addConnection'), true, busy, cx).on_click(() =>
                      settings.openAdd(),
                    ),
                  ),
                )
                .when(actions !== null, (el) => el.child(actions)),
            )
            .child(text(t(description), 'body', m.inkMuted))
            .when(status !== null, (el) => el.child(status))
            .when(!subagents && !archived && (busy || settings.error !== null), (el) =>
              el.child(
                text(
                  busy ? settings.busy : settings.error,
                  'small',
                  busy ? m.inkMuted : m.destructive,
                ),
              ),
            ),
        )
        .when(settings.page === 'general', (el) => el.children(generalSection(settings, cx)))
        .when(settings.page === 'models', (el) => el.child(modelSection(settings, cx)))
        .when(settings.page === 'connections', (el) => el.child(connectionSection(settings, cx)))
        .when(subagents, (el) => el.child(subagentsSection(settings.subagents, cx)))
        .when(archived, (el) => el.child(archivedSection(settings.archived, cx))),
    );
}

/**
 * A settings group: heading, optional description and end slot, then rows
 * split by rules. Without a title it is only the rows.
 */
export function group(title, description, end, rows, cx) {
  const m = palette(cx);
  return v_flex()
    .w_full()
    .when(title !== null, (el) =>
      el.child(
        h_flex()
          .gap(12)
          .pb(8)
          .items_end()
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .child(text(title, 'heading', m.ink))
              .when(description !== null, (el) => el.child(text(description, 'small', m.inkMuted))),
          )
          .when(end !== null, (el) => el.child(end)),
      ),
    )
    .children(rows.map((row) => div().w_full().border_t_1().border_color(m.borderSoft).child(row)));
}

/**
 * The General page, as the native client's: the language, then the
 * appearance, each a list of choices with the current one checked. Language
 * belongs to the connected Host; appearance is kept on this computer.
 */
function generalSection(settings, cx) {
  return [
    group(
      t('settingsLanguage'),
      t('settingsLanguageDetail') +
        (settings.preferences?.language === null
          ? `\n${t('languageInherited', { value: LANGUAGE_NAMES[settings.preferences.resolvedLanguage] })}`
          : ''),
      null,
      [
        choiceList(
          'language',
          LANGUAGE_CHOICES.map((value) => [
            value,
            value === 'auto' ? t('languageSystem') : LANGUAGE_NAMES[value],
          ]),
          settings.preferences?.language ?? null,
          (value) => settings.setLanguage(value),
          cx,
          settings.preferences === null || settings.loading || settings.busy !== null,
        ),
      ],
      cx,
    ),
    group(
      t('settingsAppearance'),
      t('settingsAppearanceDetail'),
      null,
      [
        choiceList(
          'appearance',
          APPEARANCES.map((value) => [value, t(`appearance_${value}`)]),
          appearancePreference(),
          (value) => {
            setAppearancePreference(value);
            settings.hooks.changed();
          },
          cx,
        ),
      ],
      cx,
    ),
  ];
}

/** Choices of which one holds: a round mark, filled and checked for the current one, and its label. */
function choiceList(id, choices, current, choose, cx, disabled = false) {
  const m = palette(cx);
  return v_flex()
    .py(4)
    .children(
      choices.map(([value, label]) => {
        const selected = value === current;
        return typeset(Button.new(`${id}-${value}`), 'body')
          .disabled(disabled)
          .h(36)
          .gap(10)
          .items_center()
          .justify_start()
          .text_color(m.ink)
          .on_click(() => choose(value))
          .child(
            div()
              .size(18)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(9)
              .when(selected, (el) => el.bg(m.ink).child(icon('check', 12, m.plate)))
              .when(!selected, (el) => el.border_1().border_color(m.border)),
          )
          .child(label);
      }),
    );
}

/** A settings row: title and detail on the left, controls at the end. */
export function settingRow(title, detail, end, cx) {
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
        .child(typeset(div(), 'label').text_color(m.ink).truncate().child(title))
        .when(detail !== null, (el) => el.child(text(detail, 'small', m.inkMuted).truncate())),
    )
    .when(end !== null, (el) => el.child(h_flex().flex_none().max_w(320).gap(8).child(end)));
}

function modelSection(settings, cx) {
  const m = palette(cx);
  const busy = settings.busy !== null;
  const { choices, defaultModel, next } = settings.models;
  const current =
    defaultModel.kind === 'ready'
      ? choiceLabel(defaultModel.choice)
      : defaultModel.kind === 'unavailable'
        ? t('defaultUnavailable')
        : t('defaultNone');
  const isDefault = (choice) =>
    defaultModel.kind === 'ready' &&
    defaultModel.choice.selection.connectionId === choice.selection.connectionId &&
    defaultModel.choice.selection.modelId === choice.selection.modelId;
  const rows = [
    settingRow(t('defaultModel'), current, null, cx),
    settingRow(t('findModel'), null, div().w(260).child(textField(settings.modelQuery, cx)), cx),
    ...choices.map((choice, index) =>
      settingRow(
        choice.label,
        choice.connectionName ?? null,
        isDefault(choice)
          ? pill(t('defaultBadge'), cx)
          : button(`model-${index}`, t('useAsDefault'), false, busy, cx)
              .h(28)
              .on_click(() => settings.setDefault(choice)),
        cx,
      ),
    ),
  ];
  if (choices.length === 0) {
    rows.push(
      h_flex()
        .py(8)
        .gap(12)
        .items_center()
        .child(text(t('noModelsYet'), 'body', m.inkMuted).flex_1())
        .child(
          button('models-connections', t('settingsConnections'), false, false, cx).on_click(() =>
            settings.showPage('connections'),
          ),
        ),
    );
  }
  if (next !== null) {
    rows.push(
      h_flex()
        .py(8)
        .child(
          button('models-more', t('showMore'), false, false, cx).on_click(() =>
            settings.moreModels(),
          ),
        ),
    );
  }
  return group(t('defaultModel'), t('defaultModelDetail'), null, rows, cx);
}

function connectionSection(settings, cx) {
  const m = palette(cx);
  const rows = settings.connections.map((connection) => connectionRow(settings, connection, cx));
  if (settings.connections.length === 0 && !settings.loading) {
    rows.push(text(t('noConnectionsYet'), 'body', m.inkMuted).py(8));
  }
  return v_flex()
    .w_full()
    .gap(32)
    .when(settings.form?.kind === 'add', (el) => el.child(addForm(settings, cx)))
    .child(group(null, null, null, rows, cx));
}

function connectionRow(settings, connection, cx) {
  const m = palette(cx);
  const busy = settings.busy !== null;
  const id = connection.basis.connectionId;
  const descriptor = settings.descriptors.get(connection.provider.name);
  const status = settings.statuses.get(id);
  const key =
    status === undefined
      ? t('keyChecking')
      : status === null
        ? t('keyStatusUnknown')
        : status.configured
          ? t('keySaved')
          : descriptor?.anonymous
            ? t('noKeyNeeded')
            : t('noKey');
  const models = tn(connection.enabledModelCount, 'modelCountOne', 'modelCountOther');
  const facts = [descriptor?.label ?? connection.provider.name, key];
  if (!connection.enabled) facts.push(t('turnedOff'));
  const note = settings.notes.get(id);
  const editing = settings.form?.kind === 'key' && settings.form.connectionId === id;
  const isDefault = settings.defaultTarget?.connectionId === id;
  const confirming = settings.removing === id;
  return v_flex()
    .w_full()
    .py(10)
    .gap(8)
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .child(
          h_flex()
            .flex_none()
            .size(32)
            .rounded(16)
            .items_center()
            .justify_center()
            .bg(m.chip)
            .child(text((connection.name.trim()[0] ?? '?').toUpperCase(), 'strong', m.ink)),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w_0()
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(typeset(div(), 'label').text_color(m.ink).truncate().child(connection.name))
                .when(isDefault, (el) => el.child(pill(t('defaultBadge'), cx))),
            )
            .child(text(facts.join(' · '), 'small', m.inkMuted).truncate()),
        )
        .child(text(models, 'body', m.inkMuted).flex_none())
        .when(connection.editable && descriptor && takesKey(descriptor), (el) =>
          el.child(
            button(`key-${id}`, t('setKey'), false, busy, cx)
              .h(28)
              .on_click(() => settings.openKey(connection)),
          ),
        )
        .when(descriptor?.discovery === true, (el) =>
          el.child(
            button(`discover-${id}`, t('findModelsButton'), false, busy, cx)
              .h(28)
              .tooltip(t('findModelsTip'))
              .on_click(() => settings.findModels(connection)),
          ),
        )
        .when(connection.editable, (el) =>
          el.child(
            button(`remove-${id}`, t('remove'), false, busy || confirming, cx)
              .h(28)
              .on_click(() => settings.askRemove(connection)),
          ),
        ),
    )
    .when(confirming, (el) =>
      el.child(
        h_flex()
          .pl(44)
          .gap(8)
          .items_center()
          .child(
            text(isDefault ? t('confirmRemoveDefault') : t('confirmRemove'), 'small', m.ink)
              .flex_1()
              .min_w_0(),
          )
          .child(
            controlButton(`remove-confirm-${id}`, t('remove'), 'outline', busy, cx)
              .h(28)
              .text_color(m.destructive)
              .on_click(() => settings.removeConnection(connection)),
          )
          .child(
            button(`remove-cancel-${id}`, t('cancel'), false, busy, cx)
              .h(28)
              .on_click(() => settings.cancelRemove()),
          ),
      ),
    )
    .when(note !== undefined, (el) => el.child(text(note, 'small', m.inkMuted).pl(44)))
    .when(editing, (el) =>
      el.child(
        h_flex()
          .pl(44)
          .gap(8)
          .items_center()
          .child(div().w(260).child(textField(settings.key, cx)))
          .child(
            button(`key-save-${id}`, t('saveKey'), true, busy, cx).on_click(() =>
              settings.saveKey(),
            ),
          )
          .child(
            button(`key-cancel-${id}`, t('cancel'), false, busy, cx).on_click(() =>
              settings.closeForm(),
            ),
          ),
      ),
    );
}

function addForm(settings, cx) {
  const m = palette(cx);
  const busy = settings.busy !== null;
  const form = settings.form;
  if (form.descriptor === null) {
    const search = settings.providerQuery.value().trim().toLowerCase();
    const matches = (settings.providers ?? []).filter(
      (p) =>
        search === '' ||
        p.label.toLowerCase().includes(search) ||
        p.identity.name.toLowerCase().includes(search),
    );
    const rows = [
      settingRow(
        t('provider'),
        null,
        div().w(260).child(textField(settings.providerQuery, cx)),
        cx,
      ),
      v_flex()
        .py(8)
        .gap(8)
        .when(settings.providers === null, (el) =>
          el.child(text(t('listingProviders'), 'body', m.inkMuted)),
        )
        .child(
          h_flex()
            .flex_wrap()
            .gap(8)
            .children(
              matches.slice(0, PROVIDER_ROWS).map((provider) =>
                button(`provider-${provider.identity.name}`, provider.label, false, busy, cx)
                  .h(28)
                  .on_click(() => settings.chooseProvider(provider)),
              ),
            ),
        )
        .when(matches.length > PROVIDER_ROWS, (el) =>
          el.child(
            text(
              t('moreProviders', { count: matches.length - PROVIDER_ROWS }),
              'small',
              m.inkMuted,
            ),
          ),
        ),
    ];
    return group(
      t('addAConnection'),
      t('chooseProvider'),
      button('add-cancel', t('cancel'), false, busy, cx).on_click(() => settings.closeForm()),
      rows,
      cx,
    );
  }
  const descriptor = form.descriptor;
  const auth = keyAuth(descriptor);
  const control = (state) => div().w(260).child(textField(state, cx));
  const rows = [settingRow(t('fieldName'), null, control(settings.name), cx)];
  if (showsEndpoint(descriptor)) {
    rows.push(settingRow(t('endpoint'), null, control(settings.endpoint), cx));
  }
  if (takesKey(descriptor)) {
    rows.push(
      settingRow(
        auth === 'optional' ? t('apiKeyOptional') : t('apiKey'),
        t('keptByHost'),
        control(settings.key),
        cx,
      ),
    );
  }
  if (auth === 'none') {
    rows.push(text(t('providerSignsInTerminalNote'), 'body', m.inkMuted).py(8));
  }
  rows.push(
    h_flex()
      .py(8)
      .gap(8)
      .justify_end()
      .child(
        button('add-cancel', t('cancel'), false, busy, cx).on_click(() => settings.closeForm()),
      )
      .child(
        button('add-save', t('add'), true, busy || auth === 'none', cx).on_click(() =>
          settings.addConnection(),
        ),
      ),
  );
  return group(
    t('addProviderConnection', { provider: descriptor.label }),
    null,
    button('add-change', t('changeProvider'), false, busy, cx).on_click(() => settings.openAdd()),
    rows,
    cx,
  );
}
