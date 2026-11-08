/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import process from 'process';
import fs from 'fs/promises';
import { Packages, type Bundle } from './packages';
import { loadWorker } from './worker';
import { rankOptions } from './model';
import { WebPlugins, configureQuickWeb } from './web';
import bilibili from '../tools/bilibili/index';
import bilibiliManifest from '../tools/bilibili/manifest.json';
import suggestions from '../tools/suggestions/index';
import suggestionsManifest from '../tools/suggestions/manifest.json';
import { resolveLink, searchEntries, normalizeSearchText, type Preference } from '../shared/search';
import { host } from 'nsh';
import chrome from '../tools/chrome/index';
import chromeManifest from '../tools/chrome/manifest.json';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import * as storage from './storage';
import * as native from './native';
import { qt, localizeManifest, setQuickLocale, quickLocale } from '../shared/i18n';
import { normalizeInputHistory, rememberInput, type InputHistory } from '../shared/input-history';
import type {
  Action,
  Context,
  Manifest,
  Plugin,
  PluginFactory,
  QuickLocale,
  ResultRow,
  Services,
  View,
} from '../shared/plugin';
import applications from '../tools/applications/index';
import applicationsManifest from '../tools/applications/manifest.json';
import calculator from '../tools/calculator/index';
import calculatorManifest from '../tools/calculator/manifest.json';
import links from '../tools/links/index';
import linksManifest from '../tools/links/manifest.json';
import notes from '../tools/notes/index';
import notesManifest from '../tools/notes/manifest.json';
import snippets from '../tools/snippets/index';
import snippetsManifest from '../tools/snippets/manifest.json';
import symbols from '../tools/symbols/index';
import symbolsManifest from '../tools/symbols/manifest.json';
import files from '../tools/files/index';
import filesManifest from '../tools/files/manifest.json';
import clipboard from '../tools/clipboard/index';
import clipboardManifest from '../tools/clipboard/manifest.json';
import assistant from '../tools/assistant/index';
import assistantManifest from '../tools/assistant/manifest.json';
import screenshot from '../tools/screenshot/index';
import screenshotManifest from '../tools/screenshot/manifest.json';

const builtins: { manifest: Manifest; create: PluginFactory }[] = [
  [assistantManifest, assistant],
  [bilibiliManifest, bilibili],
  [suggestionsManifest, suggestions],
  [chromeManifest, chrome],
  [applicationsManifest, applications],
  [linksManifest, links],
  [calculatorManifest, calculator],
  [clipboardManifest, clipboard],
  [notesManifest, notes],
  [snippetsManifest, snippets],
  [symbolsManifest, symbols],
  [filesManifest, files],
  [screenshotManifest, screenshot],
].map(([manifest, create]) => ({
  manifest: manifest as Manifest,
  create: create as PluginFactory,
}));
type Loaded = { manifest: Manifest; plugin: Plugin };
export type Page = { plugin: string; id: string } | null;

export class QuickTools {
  private plugins: Loaded[] = [];
  private workers = new Map<string, string>();
  readonly packages = new Packages();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private changePackage(run: () => Promise<void>) {
    const task = this.lifecycle.catch(() => {}).then(run);
    this.lifecycle = task;
    return task;
  }
  private web = new WebPlugins();
  private shortcuts: Record<string, string> = {};
  private words = new Map<string, string[]>();
  private preferences: Record<string, Preference> = {};
  history: InputHistory = { search: [], assistant: [] };
  private stopped = false;
  private watch: ReturnType<typeof process.spawn> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private sourcePid: string | null = null;
  constructor(
    private readonly hooks: {
      changed(): void;
      close(): void;
      assistant(text?: string): Promise<void>;
      appearance(): 'dark' | 'light';
      report(error: unknown): void;
    },
  ) {}
  async start(locale: QuickLocale) {
    setQuickLocale(locale);
    configureQuickWeb({
      open: async (signal) => ({
        call: async (name, args, signal) => {
          signal.throwIfAborted();
          const id = randomUUID();
          const cancel = () => {
            void host.call('quickTools.web.cancel', { id }).catch(() => {});
          };
          const pending = host.call('quickTools.web.call', { id, name, args });
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
          try {
            const value = await pending;
            signal.throwIfAborted();
            return value;
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
        close: async () => {},
      }),
      connect: async () => {
        const value = (await host.call('quickTools.web.connect', {})) as { connected: boolean };
        if (!value.connected)
          await native.open(
            'https://chromewebstore.google.com/detail/browsermcp-connector/lnaoghmfcdnbhgcihkakfobckmfhllkg',
          );
      },
    });
    host.on('quickTools.plugin.service', async (value) => {
      const request = value as {
        token: string;
        worker: string;
        plugin: string;
        name: string;
        input: any;
      };
      try {
        if (this.stopped) throw Error('Quick Tools stopped');
        const record = this.packages.records.find(
          (record) => record.bundle.manifest.id === request.plugin,
        );
        if (!record || this.workers.get(request.plugin) !== request.worker)
          throw Error(qt('插件已不可用'));
        if (
          this.preferences[request.plugin]?.enabled === false &&
          !request.name.startsWith('storage.')
        )
          throw Error(qt('插件已不可用'));
        let result: unknown;
        if (request.name === 'storage.read')
          result = await storage.read(request.plugin, request.input);
        else if (request.name === 'storage.write')
          await storage.write(request.plugin, request.input);
        else {
          if (
            request.name !== 'window.hide' &&
            !record.bundle.manifest.permissions.includes(request.name as any)
          )
            throw Error('Undeclared permission');
          result = await this.call(
            request.name as keyof Services,
            request.input,
            record.bundle.manifest as Manifest,
          );
        }
        await host.call('quickTools.plugin.reply', { token: request.token, value: result ?? null });
      } catch (error) {
        await host.call('quickTools.plugin.reply', { token: request.token, error: String(error) });
      }
    });
    await this.packages.start();
    this.history = normalizeInputHistory(await storage.read('input-history', {}));
    this.preferences = await storage.read('preferences', {});
    this.shortcuts = await storage.read('shortcuts', {});
    for (const builtin of builtins.filter(
      (builtin) =>
        !this.packages.records.some((record) => record.bundle.manifest.id === builtin.manifest.id),
    )) {
      if (this.stopped) return;
      if (this.preferences[builtin.manifest.id]?.enabled === false) continue;
      try {
        await this.loadBuiltin(builtin);
      } catch (error) {
        this.hooks.report(Error(`${localizeManifest(builtin.manifest).name}: ${String(error)}`));
      }
    }
    for (const record of this.packages.records) {
      if (this.stopped) return;
      if (this.preferences[record.bundle.manifest.id]?.enabled === false) continue;
      try {
        await this.loadPackage(record.bundle);
      } catch (error) {
        this.hooks.report(error);
      }
    }
    this.hooks.changed();
  }
  private async loadBuiltin(builtin: (typeof builtins)[number]) {
    const context: Context = {
      get locale() {
        return quickLocale();
      },
      storage: {
        read: (fallback) => storage.read(builtin.manifest.id, fallback),
        write: (value) => storage.write(builtin.manifest.id, value),
      },
      changed: () => {
        if (!this.stopped) this.hooks.changed();
      },
      call: (name, input) => {
        if (name !== 'window.hide' && !builtin.manifest.permissions.includes(name))
          throw Error(`Undeclared permission: ${name}`);
        return this.call(name, input, builtin.manifest);
      },
    };
    const plugin = await builtin.create(context);
    if (this.stopped) {
      await plugin.dispose?.();
      return;
    }
    this.plugins.push({ manifest: builtin.manifest, plugin });
  }
  private async loadPackage(bundle: Bundle) {
    const id = bundle.manifest.id;
    const old = this.plugins.find((plugin) => plugin.manifest.id === id);
    if (old) {
      await old.plugin.dispose?.();
      this.plugins = this.plugins.filter((plugin) => plugin !== old);
    }
    const plugin = await loadWorker(
      bundle,
      () => this.hooks.changed(),
      (token) => {
        if (token) this.workers.set(id, token);
        else this.workers.delete(id);
      },
    );
    if (this.stopped) {
      await plugin.dispose?.();
      return;
    }
    this.plugins.push({ manifest: bundle.manifest as Manifest, plugin });
    this.hooks.changed();
  }
  installPackage(token: string) {
    return this.changePackage(async () => {
      await this.loadPackage(await this.packages.commit(token));
    });
  }
  rollbackPackage(id: string) {
    return this.changePackage(async () => {
      await this.loadPackage(await this.packages.rollback(id));
    });
  }
  removePackage(id: string) {
    return this.changePackage(async () => {
      await this.packages.remove(id);
      const loaded = this.plugins.find((plugin) => plugin.manifest.id === id);
      await loaded?.plugin.dispose?.();
      this.plugins = this.plugins.filter((plugin) => plugin !== loaded);
      await this.enable(id, false);
      this.hooks.changed();
    });
  }
  locale(locale: QuickLocale) {
    setQuickLocale(locale);
    this.hooks.changed();
  }
  async remember(text: string) {
    this.history = await storage.update('input-history', this.history, (value) => {
      const current = normalizeInputHistory(value);
      return { ...current, search: rememberInput(current.search, text) };
    });
  }
  async clearHistory() {
    this.history = { search: [], assistant: [] };
    await storage.write('input-history', this.history);
    this.hooks.changed();
  }
  installed() {
    const manifests = new Map(
      [
        ...builtins,
        ...this.packages.records.map((record) => ({
          manifest: record.bundle.manifest as Manifest,
        })),
        ...this.plugins,
      ].map(({ manifest }) => [manifest.id, manifest]),
    );
    return [...manifests.values()].map((manifest) => ({
      manifest: localizeManifest(manifest),
      enabled: this.preferences[manifest.id]?.enabled !== false,
    }));
  }
  async enable(id: string, enabled: boolean) {
    if (!enabled) this.web.cancel(id);
    if (id === 'maka.clipboard' && !enabled) {
      await this.plugins
        .find((p) => p.manifest.id === id)
        ?.plugin.run('disable', undefined, {}, new AbortController().signal);
    }
    const next = { ...this.preferences, [id]: { ...this.preferences[id], enabled } };
    await storage.write('preferences', next);
    this.preferences = next;
    if (!enabled) {
      const loaded = this.plugins.find((plugin) => plugin.manifest.id === id);
      if (loaded) {
        await loaded.plugin.dispose?.();
        this.plugins = this.plugins.filter((plugin) => plugin !== loaded);
      }
    }
    if (enabled && !this.plugins.some((plugin) => plugin.manifest.id === id)) {
      const record = this.packages.records.find((record) => record.bundle.manifest.id === id);
      if (record) await this.loadPackage(record.bundle);
      else {
        const builtin = builtins.find((builtin) => builtin.manifest.id === id);
        if (builtin) await this.loadBuiltin(builtin);
      }
    }
    this.hooks.changed();
  }
  itemKey(row: ResultRow): string {
    if (row.persistable === false && row.source) {
      // Query-generated rows can reuse the same ID for different actions.
      const hash = createHash('sha256')
        .update(JSON.stringify([row.id, row.source.page ?? null, row.source.query]))
        .digest('hex');
      return `${row.plugin}:@query:${hash}`;
    }
    return `${row.plugin}:${row.id}`;
  }
  async preference(row: ResultRow, patch: Preference) {
    const key = this.itemKey(row);
    const next = { ...this.preferences, [key]: { ...this.preferences[key], ...patch } };
    if (row.source && (next[key].alias || this.shortcuts[key] || next[key].favorite))
      next[key].source = row.source;
    else delete next[key].source;
    await storage.write('preferences', next);
    this.preferences = next;
    this.hooks.changed();
  }
  shortcut(row?: ResultRow) {
    return this.shortcuts[row ? this.itemKey(row) : 'toggle'] ?? '';
  }
  async openAccessibilitySettings() {
    if (process.platform === 'macos')
      await native.run('/usr/bin/open', [
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      ]);
  }
  async setLauncherEnabled(enabled: boolean) {
    if (enabled) await this.setShortcut(await storage.read('launcher-shortcut', 'Alt+Space'));
    else {
      if (this.shortcut()) await storage.write('launcher-shortcut', this.shortcut());
      await this.setShortcut('');
    }
  }
  async setShortcut(value: string, row?: ResultRow) {
    const key = row ? this.itemKey(row) : 'toggle';
    const next = { ...this.shortcuts };
    if (value.trim()) next[key] = value.trim();
    else delete next[key];
    await this.replaceShortcuts(next);
  }
  private async replaceShortcuts(next: Record<string, string>) {
    await host.call('quickTools.shortcuts.configure', next);
    try {
      await storage.write('shortcuts', next);
    } catch (error) {
      await host.call('quickTools.shortcuts.configure', this.shortcuts);
      throw error;
    }
    this.shortcuts = next;
    this.hooks.changed();
  }
  private async removeItemBindings(plugin: string, ids: string[]) {
    const removed = new Set(ids);
    const prefs = { ...this.preferences };
    const shortcuts = { ...this.shortcuts };
    let hasShortcut = false;
    for (const key of new Set([...Object.keys(prefs), ...Object.keys(shortcuts)])) {
      if (
        !key.startsWith(plugin + ':') ||
        !removed.has(prefs[key]?.source?.id ?? key.slice(plugin.length + 1))
      )
        continue;
      delete prefs[key];
      if (key in shortcuts) {
        delete shortcuts[key];
        hasShortcut = true;
      }
    }
    if (hasShortcut) await this.replaceShortcuts(shortcuts);
    await storage.write('preferences', prefs);
    this.preferences = prefs;
    this.hooks.changed();
  }
  async configureItem(row: ResultRow, shortcut: string, patch: Preference) {
    const previous = this.shortcut(row);
    const changed = previous !== shortcut.trim();
    if (changed) await this.setShortcut(shortcut, row);
    try {
      await this.preference(row, patch);
    } catch (error) {
      if (changed) await this.setShortcut(previous, row);
      throw error;
    }
  }
  async shortcutRow(key: string): Promise<ResultRow> {
    const loaded = this.plugins.find((p) => key.startsWith(`${p.manifest.id}:`));
    if (!loaded || this.preferences[loaded.manifest.id]?.enabled === false)
      throw Error(qt('插件已不可用'));
    const source = this.preferences[key]?.source;
    const id = source?.id ?? key.slice(loaded.manifest.id.length + 1);
    const manifest = localizeManifest(loaded.manifest);
    const signal = new AbortController().signal;
    let row = manifest.commands.find((entry) => entry.id === id);
    if (!row && !key.startsWith(`${manifest.id}:@query:`)) row = await loaded.plugin.resolve?.(id);
    if (!row) {
      const rows = source?.page
        ? (await loaded.plugin.view?.(source.page, source.query, signal))?.rows
        : await loaded.plugin.search?.(source?.query ?? '', signal);
      row = rows?.find((entry) => entry.id === id);
    }
    if (!row) throw Error(qt('条目已不存在'));
    return { ...row, source, plugin: manifest.id, pluginName: manifest.name };
  }
  alias(row: ResultRow) {
    return this.preferences[this.itemKey(row)]?.alias ?? '';
  }
  async used(row: ResultRow) {
    if (row.persistable === false) return;
    const pref = this.preferences[this.itemKey(row)];
    await this.preference(row, { uses: (pref?.uses ?? 0) + 1, lastUsed: Date.now() });
  }
  favorite(row: ResultRow) {
    return this.preferences[this.itemKey(row)]?.favorite ?? false;
  }
  async search(
    page: Page,
    query: string,
    signal: AbortSignal,
  ): Promise<{ rows: ResultRow[]; view?: View }> {
    const enrich = (loaded: Loaded, rows: View['rows']) =>
      rows.map((row) => ({
        ...row,
        source: { id: row.id, query, page: page?.id },
        plugin: loaded.manifest.id,
        pluginName: localizeManifest(loaded.manifest).name,
      }));
    if (page) {
      const loaded = this.plugins.find((p) => p.manifest.id === page.plugin);
      if (!loaded?.plugin.view || this.preferences[page.plugin]?.enabled === false)
        throw Error(qt('插件已不可用'));
      const view = await loaded.plugin.view(page.id, query, signal);
      const q = query.trim().toLocaleLowerCase();
      return {
        view,
        rows: enrich(loaded, view.rows).filter(
          (row) =>
            !q ||
            row.featured ||
            [row.name, row.detail, row.keywords, this.alias(row)].some((text) =>
              text?.toLocaleLowerCase().includes(q),
            ),
        ),
      };
    }
    const groups = await Promise.all(
      this.plugins
        .filter((p) => this.preferences[p.manifest.id]?.enabled !== false)
        .map(async (loaded) => {
          const commands = localizeManifest(loaded.manifest).commands;
          let found: View['rows'] = [];
          try {
            found = (await loaded.plugin.search?.(query, signal)) ?? [];
          } catch (error) {
            if (!signal.aborted && !this.stopped)
              this.hooks.report(
                Error(`${localizeManifest(loaded.manifest).name}: ${String(error)}`),
              );
          }
          return enrich(loaded, [
            ...commands,
            ...found.filter((row) => !commands.some((command) => command.id === row.id)),
          ]);
        }),
    );
    const commands = new Set(
      this.plugins.flatMap((p) => p.manifest.commands.map((row) => `${p.manifest.id}:${row.id}`)),
    );
    const foundByKey = new Map<string, ResultRow>(
      groups.flat().map((row) => [this.itemKey(row), row]),
    );
    const q = query.trim().toLocaleLowerCase();
    const missingItems = Object.entries(this.preferences).filter(
      ([key, pref]) =>
        !foundByKey.has(key) && (q ? pref.alias?.toLocaleLowerCase().includes(q) : pref.favorite),
    );
    await Promise.all(
      missingItems.map(async ([key]) => {
        try {
          foundByKey.set(key, await this.shortcutRow(key));
        } catch {
          /* Removed or unavailable targets must not run cached actions. */
        }
      }),
    );
    const entries = [...foundByKey.values()].map((row) => ({
      ...row,
      row,
      id: this.itemKey(row),
      description: row.detail,
      kind: commands.has(`${row.plugin}:${row.id}`) ? 'tool' : row.kind,
    }));
    if (query.trim()) {
      const texts = new Set([normalizeSearchText(query.slice(0, 500))]);
      for (const row of entries)
        for (const value of [
          row.name,
          row.description ?? '',
          row.keywords ?? '',
          this.preferences[row.id]?.alias ?? '',
        ])
          texts.add(normalizeSearchText(value));
      const missing = [...texts].filter((text) => !this.words.has(text));
      for (let offset = 0; offset < missing.length; offset += 128) {
        if (signal.aborted) return { rows: [] };
        const batch = missing.slice(offset, offset + 128);
        const tokens = (await host.call('quickTools.search.words', batch)) as string[][];
        batch.forEach((text, index) => this.words.set(text, tokens[index]));
      }
    }
    const ranked = searchEntries(
      entries,
      query,
      this.preferences,
      (text) => this.words.get(text) ?? [],
    );
    const featured = entries.filter((entry) => entry.featured);
    const exact = q
      ? ranked.filter((entry) => this.alias(entry.row).toLocaleLowerCase() === q)
      : [];
    const rows = [...new Set([...exact, ...featured, ...ranked])]
      .slice(0, 80)
      .map((entry) => entry.row);
    if (this.words.size > 8000) this.words.clear();
    return { rows };
  }

  async suggest(
    query: string,
    rows: ResultRow[],
    signal: AbortSignal,
  ): Promise<ResultRow[] | null> {
    if (
      rows.some((row) => this.alias(row).toLocaleLowerCase() === query.trim().toLocaleLowerCase())
    )
      return null;
    const plugin = this.plugins.find(
      (p) => p.manifest.suggestions && this.preferences[p.manifest.id]?.enabled !== false,
    );
    if (!plugin?.plugin.suggest || signal.aborted || query.trim().length < 2 || !rows.length)
      return null;
    const input = {
      query: query.slice(0, 500),
      candidates: rows.slice(0, 80).map((row) => ({
        id: this.itemKey(row),
        name: row.name.slice(0, 500),
        kind: (row.kind ?? row.pluginName).slice(0, 100),
        uses: Math.min(this.preferences[this.itemKey(row)]?.uses ?? 0, 100000),
      })),
    };
    // Built-in ranker uses the same abortable, journaled native operation as other auxiliary model work.
    const ranked =
      plugin.manifest.id === 'maka.suggestions'
        ? await rankOptions(input, signal)
        : await plugin.plugin.suggest(input, signal);
    if (signal.aborted || !ranked.ids.length) return null;
    const selected = ranked.ids
      .map((id) => rows.find((row) => this.itemKey(row) === id))
      .filter((row): row is ResultRow => !!row);
    return [...selected, ...rows.filter((row) => !selected.includes(row))];
  }
  run(
    pluginId: string,
    action: Action,
    values: Record<string, string | boolean>,
    signal: AbortSignal,
  ) {
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        const loaded = this.plugins.find((p) => p.manifest.id === pluginId);
        if (!loaded || this.preferences[pluginId]?.enabled === false)
          throw Error(qt('插件已不可用'));
        try {
          const result = await loaded.plugin.run(action.id, action.data, values, signal);
          if (result?.removed?.length) await this.removeItemBindings(pluginId, result.removed);
          void storage.trace('execute', pluginId, action.id, true).catch(this.hooks.report);
          return result;
        } catch (error) {
          void storage.trace('execute', pluginId, action.id, false).catch(this.hooks.report);
          throw error;
        }
      });
    this.writes = task;
    return task;
  }
  setSource(pid?: number) {
    this.sourcePid = pid && pid > 0 ? String(pid) : null;
  }
  async captureSource() {
    if (process.platform !== 'macos') return;
    const source = JSON.parse(await native.run(native.helperPath(), ['frontmost']));
    this.sourcePid = source.pid ? String(source.pid) : null;
  }
  private async call<K extends keyof Services>(
    name: K,
    input: Services[K]['input'],
    manifest?: Manifest,
  ): Promise<Services[K]['output']> {
    let result: unknown;
    switch (name) {
      case 'web.connect':
        await this.web.connect();
        break;
      case 'web.run':
        if (!manifest) throw Error('Missing plugin web declaration');
        result = await this.web.run(
          manifest,
          input,
          () => !this.stopped && this.preferences[manifest.id]?.enabled !== false,
        );
        break;
      case 'model.rank':
        result = await rankOptions(
          input as Services['model.rank']['input'],
          new AbortController().signal,
        );
        break;
      case 'browser.tabs.read':
        result = await host.call('quickTools.chrome.list', {});
        break;
      case 'browser.tabs.manage':
        if ((input as Services['browser.tabs.manage']['input']).action === 'activate')
          this.hooks.close();
        await host.call('quickTools.chrome.run', input);
        break;
      case 'browser.tabs.connect': {
        const connection = (await host.call('quickTools.chrome.connect', {})) as {
          directory: string;
        };
        await native.open(join(connection.directory, 'manifest.json'), true);
        break;
      }
      case 'window.hide':
        this.hooks.close();
        break;
      case 'applications.list':
        result = await native.applications();
        break;
      case 'system.open':
        if (manifest === (linksManifest as Manifest))
          await native.open(resolveLink(input as string), false, true);
        else await native.open(input as string);
        break;
      case 'system.reveal':
        await native.open(input as string, true);
        break;
      case 'text.transliterate':
        result = await native
          .run(native.helperPath(), ['transliterate', JSON.stringify([input])])
          .then((value) => JSON.parse(value)[0]);
        break;
      case 'clipboard.read':
        result = await native.readClipboard();
        break;
      case 'clipboard.write':
        await native.writeClipboard(input as Services['clipboard.write']['input']);
        break;
      case 'paste': {
        const targetPid = this.sourcePid;
        await native.writeClipboard(input as Services['paste']['input']);
        this.hooks.close();
        if (!targetPid) throw Error(qt('内容已复制，请手动粘贴'));
        await native.run(native.helperPath(), ['paste', targetPid]);
        break;
      }
      case 'clipboard.watch':
        this.watch?.kill();
        this.watch = null;
        if (input && this.preferences['maka.clipboard']?.enabled !== false) {
          const child = process.spawn(native.helperPath(), ['watch'], {
            stdin: 'pipe',
            lines: true,
          });
          this.watch = child;
          child.on('stdout', (line) => {
            try {
              if (
                this.stopped ||
                this.watch !== child ||
                this.preferences['maka.clipboard']?.enabled === false
              )
                return;
              const event = JSON.parse(line);
              void Promise.resolve(
                this.plugins
                  .find((p) => p.manifest.id === 'maka.clipboard')
                  ?.plugin.event?.('clipboard', event),
              ).catch(this.hooks.report);
            } catch (error) {
              this.hooks.report(error);
            }
          });
          child.on('exit', (exit) => {
            if (this.watch === child) {
              this.watch = null;
              if (!this.stopped && exit.code !== 0)
                this.hooks.report(Error(qt('剪贴板监听已停止')));
            }
          });
        }
        break;
      case 'assistant.open':
        await this.hooks.assistant((input as Services['assistant.open']['input']).text);
        break;
      case 'screenshots.capture': {
        this.hooks.close();
        await storage.prepare();
        const file = join(storage.directory(), `capture-${randomUUID()}.png`);
        const capture = await process.run('/usr/sbin/screencapture', ['-i', file], {
          timeoutMs: 120000,
        });
        if (capture.code !== 0) {
          await fs.unlink(file).catch((error) => {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
          });
          if (capture.code === 1 && !capture.stderr.trim()) break;
          throw Error(capture.stderr.trim() || qt('截图失败'));
        }
        await native.imageWindow('edit', file, quickLocale(), this.hooks.appearance());
        break;
      }
      case 'screenshots.pin': {
        const clip = await native.readClipboard();
        if (!clip.image) throw Error(qt('剪贴板中没有图片'));
        await storage.prepare();
        const file = join(storage.directory(), `pin-${randomUUID()}.json`);
        await fs.writeFile(file, JSON.stringify({ image: clip.image }));
        await native.imageWindow('pin', file, quickLocale(), this.hooks.appearance());
        break;
      }
      default:
        throw Error(`Unsupported native capability: ${name}`);
    }
    return result as Services[K]['output'];
  }
  async dispose() {
    this.stopped = true;
    this.web.cancel();
    native.closeImageWindows();
    this.watch?.kill();
    await Promise.all(this.plugins.map((p) => p.plugin.dispose?.()));
    this.plugins = [];
  }
}
