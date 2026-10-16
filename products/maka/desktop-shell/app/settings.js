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

// Settings: model connections, their API keys, the default model, and import
// from an old Maka settings export. The calls follow the TUI's settings
// plugins (plugins/settings/connection-form/operations.ts and
// plugins/settings/credential/index.ts): create the connection, save its key
// as the `secret` resource of `settings.saveCredential`, then let
// `setup.discoverModels` find and enable its models.
//
// A key lives only in the masked input, or in memory between reading an
// export and importing it; it is never logged, and import rows drop it once
// they are done.

import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Button } from 'gpui-base';
import { openText } from 'maka-files';
import { query, operation, log } from './host.js';
import {
  palette,
  typeset,
  text,
  icon,
  pill,
  ghostButton,
  controlButton,
  textField,
} from './theme.js';

/** A control button in the settings' style: primary or outline. */
function button(id, label, primary, disabled, cx) {
  return controlButton(id, label, primary ? 'primary' : 'outline', disabled, cx);
}

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_PAGES = 32;
/** Providers listed at once while choosing one. */
const PROVIDER_ROWS = 12;

const KEY_REJECTIONS = {
  invalid_input: 'the request was not valid',
  invalid_secret: 'the key is empty, too long, or has control characters',
  secret_unavailable: 'the key could not be read',
  provider_unavailable: 'this Host does not offer the provider',
  authentication_unavailable: 'the provider does not take an API key',
  attempt_conflict: 'another save was in progress; try again',
  connection_changed: 'the connection changed meanwhile; try again',
  credential_changed: 'the key changed meanwhile; try again',
  capacity: 'the key store is full',
  slug_taken: 'the connection ID is taken',
  authentication: 'the provider did not accept the key',
};

export class Settings {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, report: (message: string) => void, modelsChanged: () => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.open = false;
    /** The page shown: "models" or "connections". */
    this.page = 'models';
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
    /** { path, rows, error, done } while an export is being imported. */
    this.importing = null;

    this.modelQuery = InputState.new({ placeholder: 'Find a model' });
    this.modelQuery.on('change', () => this.loadModels());
    this.providerQuery = InputState.new({ placeholder: 'Find a provider' });
    this.providerQuery.on('change', () => this.hooks.changed());
    this.name = InputState.new({ placeholder: 'Name' });
    this.endpoint = InputState.new({ placeholder: 'Endpoint URL' });
    this.key = InputState.new({ placeholder: 'API key' });
    this.key.set_masked(true);
  }

  show(page = null) {
    if (page !== null) this.page = page;
    this.open = true;
    this.load();
    this.hooks.changed();
  }

  showPage(page) {
    if (this.page === page) return;
    this.page = page;
    this.hooks.changed();
  }

  hide() {
    this.open = false;
    this.closeForm();
    this.closeImport();
    this.hooks.changed();
  }

  async load() {
    this.loading = true;
    this.error = null;
    this.hooks.changed();
    try {
      await this.loadConnections();
      await Promise.all([this.loadStatuses(), this.loadDescriptors(), this.loadModels()]);
    } catch (error) {
      this.fail('Settings', error);
    } finally {
      this.loading = false;
      this.hooks.changed();
    }
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
        if (pages >= MAX_PAGES) throw new Error('the connection list has too many pages');
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
    throw new Error('the connection list kept changing; try again');
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
          this.descriptor(
            this.connections.find((c) => c.provider.name === name).provider,
          ).catch(() => null),
        ),
    );
  }

  /** The provider's descriptor, read once. */
  async descriptor(identity) {
    const known = this.descriptors.get(identity.name);
    if (known) return known;
    const provider = await query('authentication', 'provider', identity);
    if (!provider?.descriptor) throw new Error(`no description of provider ${identity.name}`);
    this.descriptors.set(identity.name, provider.descriptor);
    return provider.descriptor;
  }

  async loadProviders() {
    const providers = [];
    for (let offset = 0, pages = 0; offset !== null && offset !== undefined; pages += 1) {
      if (pages >= MAX_PAGES) throw new Error('the provider list has too many pages');
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
      if (page.kind !== 'ready') page = await query('settings', 'models', { kind: 'start', query: search });
      if (read !== this.modelReads) return;
      if (page.kind !== 'ready') throw new Error('the model list kept changing; try again');
      this.models = {
        revision: page.revision,
        choices: page.choices,
        defaultModel: page.defaultModel,
        next: page.next ?? null,
      };
    } catch (error) {
      if (read === this.modelReads) this.fail('Models', error);
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
      if (read === this.modelReads) this.fail('Models', error);
    }
    this.hooks.changed();
  }

  /** Runs one change at a time; its failure is shown on the page and in the status line. */
  async run(label, work) {
    if (this.busy !== null) return;
    this.busy = label;
    this.error = null;
    this.hooks.changed();
    try {
      await work();
    } catch (error) {
      this.fail(label.replace(/…$/, ''), error);
    } finally {
      this.busy = null;
      this.hooks.changed();
    }
  }

  fail(what, error) {
    this.error = `${what}: ${error.message}`;
    this.hooks.report(this.error);
  }

  setDefault(choice) {
    return this.run('Setting the default model…', async () => {
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
    this.closeImport();
    this.form = { kind: 'add', provider: null, descriptor: null };
    this.providerQuery.set_value('');
    if (this.providers === null) {
      this.loadProviders().then(
        () => this.hooks.changed(),
        (error) => this.fail('Providers', error),
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
      this.fail('Provider', error);
    }
    this.hooks.changed();
  }

  openKey(connection) {
    if (this.busy !== null) return;
    this.closeImport();
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
    return this.run(`Adding ${name}…`, async () => {
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
      this.error = 'Enter the API key';
      this.hooks.changed();
      return;
    }
    return this.run('Saving the key…', async () => {
      const id = form.connectionId;
      try {
        await this.storeKey(id, key);
        this.notes.set(id, `Key saved; ${await this.discover(id)}`);
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
    return this.run('Removing the connection…', async () => {
      this.removing = null;
      const result = await operation('settings', 'remove', {
        expected: { connectionId: basis.connectionId, revision: basis.revision },
      });
      if (result.kind !== 'committed') throw new Error(describeCatalog(result));
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
    return this.run('Finding models…', async () => {
      this.notes.set(id, await this.discover(id));
    });
  }

  /**
   * Creates a connection, saves its key and finds its models. A key the
   * provider refuses leaves the connection in place without one, so the
   * error says so and Set key can retry.
   * @param {(step: string) => void} [progress]
   */
  async connect(spec, progress = () => {}) {
    progress('Creating the connection');
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
    if (!connectionId) throw new Error('the Host created no connection');
    log(`settings: created ${spec.slug}`);
    await this.loadConnections();
    let note = 'Added';
    if (spec.key) {
      progress('Saving the key');
      try {
        await this.storeKey(connectionId, spec.key);
      } catch (error) {
        throw new Error(`added without a key: ${error.message}`);
      } finally {
        await this.loadStatuses();
      }
      note = 'Key saved';
    }
    if (spec.descriptor.discovery) {
      progress('Finding models');
      note = `${note}; ${await this.discover(connectionId)}`;
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
        ? { locator: current.locator, credentialId: current.credentialId, revision: current.revision }
        : null;
    const result = await operation(
      'settings',
      'saveCredential',
      { expected: target, expectedCredential },
      { secret: key },
    );
    log(`settings: saveCredential ${target.slug} ${result.kind} ${result.reason ?? ''}`);
    if (result.kind !== 'saved') {
      throw new Error(KEY_REJECTIONS[result.reason] ?? `the Host refused the key (${result.reason})`);
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
      return count === 1 ? '1 model enabled' : `${count} models enabled`;
    }
    return result.kind === 'superseded'
      ? 'the connection changed while finding models; use Find models again'
      : 'finding models failed; check the key and the endpoint, then use Find models';
  }

  /** The connection as a credential target at its current revision. */
  async target(connectionId) {
    const connection = this.find(connectionId);
    if (!connection) throw new Error('the connection is gone');
    let detail = await query('settings', 'connection', connection.basis);
    if (detail.kind === 'stale' && detail.actual?.connectionId === connectionId) {
      detail = await query('settings', 'connection', detail.actual);
    }
    if (detail.kind !== 'ready') throw new Error('the connection changed meanwhile; try again');
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

  /** Shows the open panel and reads the chosen export. */
  async chooseImport() {
    if (this.busy !== null) return;
    let file;
    try {
      file = await openText({ prompt: 'Import', maxBytes: 1 << 20 });
    } catch (error) {
      this.fail('Import', error);
      return;
    }
    if (file !== null) await this.prepareImport(file.path, file.text);
  }

  /** Lists what an export holds and what importing it would do. */
  async prepareImport(path, text) {
    this.closeForm();
    this.closeImport();
    try {
      if (this.providers === null) await this.loadProviders();
      await this.loadConnections();
      this.importing = {
        path,
        rows: importRows(text, this.providers, this.connections),
        error: null,
        done: false,
      };
    } catch (error) {
      this.importing = { path, rows: [], error: error.message, done: true };
    }
    this.hooks.changed();
  }

  runImport() {
    const plan = this.importing;
    if (plan === null || plan.done) return;
    return this.run('Importing…', async () => {
      try {
        for (const row of plan.rows.filter((r) => r.state === 'ready')) {
          row.state = 'working';
          this.hooks.changed();
          try {
            const descriptor = await this.descriptor(row.provider.identity);
            const outcome = await this.connect(
              {
                provider: row.provider.identity,
                descriptor,
                name: row.name,
                slug: row.slug,
                endpoint: row.endpoint,
                key: row.key,
              },
              (step) => {
                row.note = step;
                this.hooks.changed();
              },
            );
            row.state = 'done';
            row.note = outcome.note;
          } catch (error) {
            row.state = 'failed';
            row.note = error.message;
          } finally {
            row.key = null;
            this.hooks.changed();
          }
        }
      } finally {
        plan.done = true;
        for (const row of plan.rows) row.key = null;
      }
    });
  }

  closeImport() {
    for (const row of this.importing?.rows ?? []) row.key = null;
    this.importing = null;
    this.hooks.changed();
  }
}

/**
 * The rows an old Maka settings export (schema version 1) turns into: one per
 * API key, matched to this Host's provider of the same name. Rows that cannot
 * be imported say why.
 */
export function importRows(text, providers, connections) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the file is not JSON');
  }
  const credentials = data?.data?.credentials;
  if (data?.schemaVersion !== 1 || !Array.isArray(credentials)) {
    throw new Error('the file is not a Maka settings export with keys (schema version 1)');
  }
  const taken = new Set(connections.map((c) => c.slug));
  return credentials.map((credential) => {
    const type = String(credential?.connection?.providerType ?? 'unknown');
    const provider = providers.find((p) => p.identity.name === type) ?? null;
    const slug = typeof credential?.slug === 'string' ? credential.slug : '';
    const endpoint =
      typeof credential?.connection?.effectiveBaseUrl === 'string'
        ? credential.connection.effectiveBaseUrl
        : '';
    const key =
      credential?.kind === 'api_key' && typeof credential.value === 'string'
        ? credential.value.trim()
        : '';
    const row = {
      slug,
      provider,
      name: provider?.label ?? type,
      endpoint,
      key,
      state: 'ready',
      note: '',
    };
    if (credential?.kind !== 'api_key') return skip(row, 'only API keys can be imported');
    if (provider === null) return skip(row, `this Host has no provider "${type}"`);
    if (!SLUG.test(slug) || slug.length > 64) return skip(row, 'its ID is not a valid connection ID');
    if (taken.has(slug)) return skip(row, 'a connection with this ID exists');
    if (key === '') return skip(row, 'the key is empty');
    taken.add(slug);
    return row;
  });
}

function skip(row, note) {
  row.state = 'skipped';
  row.note = note;
  row.key = null;
  return row;
}

/** Why the add form cannot be sent, or null. */
function checkConnection(descriptor, name, endpoint, key) {
  if (name === '' || name.length > 256) return 'Enter a name of at most 256 characters';
  if (showsEndpoint(descriptor) && endpoint === '') return 'Enter the endpoint URL';
  const auth = keyAuth(descriptor);
  if (auth === 'none') return 'This provider signs in through the terminal app (maka) for now';
  if (auth === 'required' && key === '') return 'Enter the API key';
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
  const defaults = isObject(descriptor.configurationDefaults) ? descriptor.configurationDefaults : {};
  return typeof defaults.baseUrl === 'string' || descriptor.customEndpoint === true;
}

/** The provider's default configuration, with the endpoint when it differs from the default. */
function configurationFor(descriptor, endpoint) {
  const defaults = isObject(descriptor.configurationDefaults) ? descriptor.configurationDefaults : {};
  if (endpoint === '') return { ...defaults };
  const trim = (url) => url.replace(/\/+$/, '');
  return typeof defaults.baseUrl === 'string' && trim(defaults.baseUrl) === trim(endpoint)
    ? { ...defaults }
    : { ...defaults, baseUrl: endpoint };
}

function describeCatalog(result) {
  switch (result.kind) {
    case 'connection_exists':
      return `a connection with ID ${result.slug} exists`;
    case 'connection_stale':
      return 'the connection changed meanwhile; try again';
    case 'revision_conflict':
      return 'the settings changed meanwhile; try again';
    case 'invalid_default_target':
      return 'that model cannot be the default';
    case 'rejected':
      return `the Host refused it (${result.reason})`;
    default:
      return `unexpected answer ${result.kind}`;
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

function choiceLabel(choice) {
  return choice.connectionName ? `${choice.label} · ${choice.connectionName}` : choice.label;
}

const PAGES = [
  ['models', 'Models', 'cpu', 'The model new tasks use, from the connections below.'],
  ['connections', 'Connections', 'tool-plug', 'Model providers and their API keys.'],
];

/**
 * The settings navigation, in the sidebar's place.
 * @param {Settings} settings
 * @param {() => void} close
 */
export function settingsNav(settings, close, cx) {
  const m = palette(cx);
  return v_flex()
    .w(256)
    .flex_none()
    .h_full()
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
        .child('Back to app'),
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
        .child('Settings'),
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
          .child(label);
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
                .child(text(title, 'display', m.ink).flex_1())
                .when(settings.loading, (el) => el.child(text('Loading…', 'small', m.inkMuted)))
                .when(settings.page === 'connections', (el) =>
                  el
                    .child(
                      button('connection-import', 'Import from Maka export…', false, busy, cx)
                        .tooltip('Read the API keys from a settings file exported by the old Maka app')
                        .on_click(() => settings.chooseImport()),
                    )
                    .child(
                      button('connection-add', 'Add connection', true, busy, cx).on_click(() =>
                        settings.openAdd(),
                      ),
                    ),
                ),
            )
            .child(text(description, 'body', m.inkMuted))
            .when(busy || settings.error !== null, (el) =>
              el.child(
                text(
                  busy ? settings.busy : settings.error,
                  'small',
                  busy ? m.inkMuted : m.destructive,
                ),
              ),
            ),
        )
        .when(settings.page === 'models', (el) => el.child(modelSection(settings, cx)))
        .when(settings.page === 'connections', (el) => el.child(connectionSection(settings, cx))),
    );
}

/**
 * A settings group: heading, optional description and end slot, then rows
 * split by rules. Without a title it is only the rows.
 */
function group(title, description, end, rows, cx) {
  const m = palette(cx);
  return v_flex()
    .w_full()
    .when(title !== null, (el) => el.child(
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
    ))
    .children(
      rows.map((row) => div().w_full().border_t_1().border_color(m.borderSoft).child(row)),
    );
}

/** A settings row: title and detail on the left, controls at the end. */
function settingRow(title, detail, end, cx) {
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
        ? 'Unavailable; choose another'
        : 'None; new tasks use the first model listed';
  const isDefault = (choice) =>
    defaultModel.kind === 'ready' &&
    defaultModel.choice.selection.connectionId === choice.selection.connectionId &&
    defaultModel.choice.selection.modelId === choice.selection.modelId;
  const rows = [
    settingRow('Default model', current, null, cx),
    settingRow('Find a model', null, div().w(260).child(textField(settings.modelQuery, cx)), cx),
    ...choices.map((choice, index) =>
      settingRow(
        choice.label,
        choice.connectionName ?? null,
        isDefault(choice)
          ? pill('Default', cx)
          : button(`model-${index}`, 'Use as default', false, busy, cx)
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
        .child(text('No models yet. Add a connection with a key.', 'body', m.inkMuted).flex_1())
        .child(
          button('models-connections', 'Connections', false, false, cx).on_click(() =>
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
          button('models-more', 'Show more', false, false, cx).on_click(() => settings.moreModels()),
        ),
    );
  }
  return group('Default model', 'New tasks start with this model; the composer can pick another.', null, rows, cx);
}

function connectionSection(settings, cx) {
  const m = palette(cx);
  const rows = settings.connections.map((connection) => connectionRow(settings, connection, cx));
  if (settings.connections.length === 0 && !settings.loading) {
    rows.push(text('No connections yet.', 'body', m.inkMuted).py(8));
  }
  return v_flex()
    .w_full()
    .gap(32)
    .when(settings.form?.kind === 'add', (el) => el.child(addForm(settings, cx)))
    .when(settings.importing !== null, (el) => el.child(importPanel(settings, cx)))
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
      ? 'Key: …'
      : status === null
        ? 'Key status unknown'
        : status.configured
          ? 'Key saved'
          : descriptor?.anonymous
            ? 'No key needed'
            : 'No key';
  const models =
    connection.enabledModelCount === 1 ? '1 model' : `${connection.enabledModelCount} models`;
  const facts = [descriptor?.label ?? connection.provider.name, key];
  if (!connection.enabled) facts.push('Turned off');
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
                .when(isDefault, (el) => el.child(pill('Default', cx))),
            )
            .child(text(facts.join(' · '), 'small', m.inkMuted).truncate()),
        )
        .child(text(models, 'body', m.inkMuted).flex_none())
        .when(connection.editable && descriptor && takesKey(descriptor), (el) =>
          el.child(
            button(`key-${id}`, 'Set key', false, busy, cx)
              .h(28)
              .on_click(() => settings.openKey(connection)),
          ),
        )
        .when(descriptor?.discovery === true, (el) =>
          el.child(
            button(`discover-${id}`, 'Find models', false, busy, cx)
              .h(28)
              .tooltip('Ask the provider which models it offers and enable them')
              .on_click(() => settings.findModels(connection)),
          ),
        )
        .when(connection.editable, (el) =>
          el.child(
            button(`remove-${id}`, 'Remove', false, busy || confirming, cx)
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
            text(
              isDefault
                ? 'Remove this connection, its API keys and the default model? Tasks that used it are kept.'
                : 'Remove this connection and its API keys? Tasks that used it are kept.',
              'small',
              m.ink,
            )
              .flex_1()
              .min_w_0(),
          )
          .child(
            controlButton(`remove-confirm-${id}`, 'Remove', 'outline', busy, cx)
              .h(28)
              .text_color(m.destructive)
              .on_click(() => settings.removeConnection(connection)),
          )
          .child(
            button(`remove-cancel-${id}`, 'Cancel', false, busy, cx)
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
            button(`key-save-${id}`, 'Save key', true, busy, cx).on_click(() => settings.saveKey()),
          )
          .child(
            button(`key-cancel-${id}`, 'Cancel', false, busy, cx).on_click(() =>
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
      settingRow('Provider', null, div().w(260).child(textField(settings.providerQuery, cx)), cx),
      v_flex()
        .py(8)
        .gap(8)
        .when(settings.providers === null, (el) =>
          el.child(text('Listing providers…', 'body', m.inkMuted)),
        )
        .child(
          h_flex()
            .flex_wrap()
            .gap(8)
            .children(
              matches
                .slice(0, PROVIDER_ROWS)
                .map((provider) =>
                  button(`provider-${provider.identity.name}`, provider.label, false, busy, cx)
                    .h(28)
                    .on_click(() => settings.chooseProvider(provider)),
                ),
            ),
        )
        .when(matches.length > PROVIDER_ROWS, (el) =>
          el.child(
            text(`${matches.length - PROVIDER_ROWS} more; type to narrow the list`, 'small', m.inkMuted),
          ),
        ),
    ];
    return group(
      'Add a connection',
      'Choose the provider',
      button('add-cancel', 'Cancel', false, busy, cx).on_click(() => settings.closeForm()),
      rows,
      cx,
    );
  }
  const descriptor = form.descriptor;
  const auth = keyAuth(descriptor);
  const control = (state) => div().w(260).child(textField(state, cx));
  const rows = [settingRow('Name', null, control(settings.name), cx)];
  if (showsEndpoint(descriptor)) rows.push(settingRow('Endpoint', null, control(settings.endpoint), cx));
  if (takesKey(descriptor)) {
    rows.push(
      settingRow(
        auth === 'optional' ? 'API key (optional)' : 'API key',
        'Kept by the Host; never shown again',
        control(settings.key),
        cx,
      ),
    );
  }
  if (auth === 'none') {
    rows.push(
      text('This provider signs in through the terminal app (maka) for now.', 'body', m.inkMuted).py(8),
    );
  }
  rows.push(
    h_flex()
      .py(8)
      .gap(8)
      .justify_end()
      .child(button('add-cancel', 'Cancel', false, busy, cx).on_click(() => settings.closeForm()))
      .child(
        button('add-save', 'Add', true, busy || auth === 'none', cx).on_click(() =>
          settings.addConnection(),
        ),
      ),
  );
  return group(
    `Add a ${descriptor.label} connection`,
    null,
    button('add-change', 'Change provider', false, busy, cx).on_click(() => settings.openAdd()),
    rows,
    cx,
  );
}

function importPanel(settings, cx) {
  const m = palette(cx);
  const busy = settings.busy !== null;
  const plan = settings.importing;
  const ready = plan.rows.filter((row) => row.state === 'ready').length;
  const states = {
    ready: 'Will be imported',
    skipped: 'Skipped',
    working: 'Importing',
    done: 'Imported',
    failed: 'Failed',
  };
  const rows = plan.rows.map((row) =>
    settingRow(
      `${row.name} (${row.slug || 'no ID'})`,
      [row.endpoint, row.note].filter((part) => part).join(' · ') || null,
      text(states[row.state], 'small', row.state === 'failed' ? m.destructive : m.inkMuted),
      cx,
    ),
  );
  if (plan.error !== null) rows.push(text(plan.error, 'body', m.destructive).py(8));
  if (plan.error === null && plan.rows.length === 0) {
    rows.push(text('The file has no keys.', 'body', m.inkMuted).py(8));
  }
  rows.push(
    h_flex()
      .py(8)
      .gap(8)
      .justify_end()
      .child(
        button('import-close', plan.done ? 'Close' : 'Cancel', false, busy, cx).on_click(() =>
          settings.closeImport(),
        ),
      )
      .when(!plan.done && ready > 0, (el) =>
        el.child(
          button('import-run', ready === 1 ? 'Import 1 key' : `Import ${ready} keys`, true, busy, cx)
            .on_click(() => settings.runImport()),
        ),
      ),
  );
  return group(`Import from ${plan.path.split('/').pop()}`, plan.path, null, rows, cx);
}
