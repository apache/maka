/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
export type QuickLocale = 'en' | 'zh-CN' | 'zh-TW';
/** Data-only UI protocol. Plugin code never runs in the panel renderer. */
export interface Field {
  id: string;
  label: string;
  type?: 'text' | 'textarea' | 'checkbox';
  required?: boolean;
  maxLength?: number;
}
export interface Form {
  title: string;
  fields: Field[];
  values?: Record<string, string | boolean>;
  draftKey?: string;
}
export interface Action {
  id: string;
  title: string;
  data?: unknown;
  form?: Form;
  confirm?: string;
}
export type ToolIcon =
  | 'browser'
  | 'screenshot'
  | 'application'
  | 'calculator'
  | 'link'
  | 'snippet'
  | 'clipboard'
  | 'extension'
  | 'search'
  | 'star'
  | `data:image/png;base64,${string}`;
export interface Row {
  icon?: ToolIcon;
  id: string;
  name: string;
  kind?: string;
  keywords?: string;
  detail?: string;
  image?: string;
  actions: Action[];
  featured?: boolean;
  persistable?: boolean;
}
export interface View {
  title: string;
  rows: Row[];
  actions?: Action[];
  notice?: string;
}
export interface ResultRow extends Row {
  source?: { id: string; query: string; page?: string };
  plugin: string;
  pluginName: string;
}
export type Permission =
  | 'web.run'
  | 'web.connect'
  | 'screenshots.capture'
  | 'screenshots.pin'
  | 'browser.tabs.read'
  | 'browser.tabs.manage'
  | 'browser.tabs.connect'
  | 'assistant.open'
  | 'model.rank'
  | 'applications.list'
  | 'system.open'
  | 'system.reveal'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'clipboard.watch'
  | 'paste'
  | 'text.transliterate';
export interface Manifest {
  /** Optional web capability declaration; installation uses the same package lifecycle. */
  web?: {
    runtime: 'opencli';
    commands: {
      id: string;
      site: string;
      command: string;
      domain: string;
      access: 'read';
      request?: { origin: string; path: string; params: string[] };
    }[];
  };
  locales?: Partial<
    Record<
      'en' | 'zh-CN',
      {
        name?: string;
        description?: string;
        commands?: Record<
          string,
          {
            name?: string;
            kind?: string;
            actions?: Record<string, string>;
          }
        >;
      }
    >
  >;
  icon?: ToolIcon;
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Permission[];
  commands: Row[];
  suggestions?: boolean;
}
export interface PackagePreview {
  token: string;
  manifest: Manifest;
  currentVersion?: string;
  digest: string;
}
export interface PluginStatus {
  previousVersion?: string;
  manifest: Manifest;
  enabled: boolean;
  error?: string;
}
export interface ClipboardSource {
  bundle: string;
  name: string;
}
export interface ClipboardValue {
  text?: string;
  image?: string;
  sensitive?: boolean;
}
export interface SuggestionInput {
  query: string;
  candidates: { id: string; name: string; kind: string; uses: number }[];
}
export interface SuggestionResult {
  source: 'jev' | 'assistant' | 'local';
  ids: string[];
}
export interface Services {
  'web.run': {
    input: { command: string; args: Record<string, unknown> };
    output: { rows: unknown[]; value?: unknown };
  };
  'web.connect': { input: undefined; output: void };
  'browser.tabs.read': {
    input: undefined;
    output: {
      connected: boolean;
      tabs: { key: string; title: string; url: string; pinned: boolean; windowId: number }[];
    };
  };
  'browser.tabs.manage': {
    input: { key: string; action: 'activate' | 'close' | 'pin' };
    output: void;
  };
  'browser.tabs.connect': { input: undefined; output: void };
  'screenshots.capture': { input: undefined; output: void };
  'screenshots.pin': { input: undefined; output: void };
  'assistant.open': { input: { text?: string }; output: void };
  'model.rank': { input: SuggestionInput; output: SuggestionResult };
  'applications.list': {
    input: undefined;
    output: { id: string; name: string; target: string; icon?: ToolIcon; keywords?: string }[];
  };
  'system.open': { input: string; output: void };
  'system.reveal': { input: string; output: void };
  'clipboard.read': { input: undefined; output: ClipboardValue };
  'clipboard.write': { input: ClipboardValue; output: void };
  'clipboard.watch': { input: boolean; output: void };
  paste: { input: ClipboardValue; output: void };
  'text.transliterate': { input: string; output: string };
  'window.hide': { input: undefined; output: void };
}
export interface Context {
  readonly locale?: QuickLocale;
  storage: { read<T>(fallback: T): Promise<T>; write(value: unknown): Promise<void> };
  call<K extends keyof Services>(
    name: K,
    input: Services[K]['input'],
  ): Promise<Services[K]['output']>;
  changed(): void;
}
export interface ActionResult {
  navigate?: string;
  removed?: string[];
}
export interface Plugin {
  suggest?(
    input: SuggestionInput,
    signal: AbortSignal,
  ): Promise<SuggestionResult> | SuggestionResult;
  resolve?(id: string): Promise<Row | undefined> | Row | undefined;
  search?(query: string, signal: AbortSignal): Promise<Row[]> | Row[];
  view?(id: string, query: string, signal: AbortSignal): Promise<View> | View;
  run(
    action: string,
    data: unknown,
    values: Record<string, string | boolean>,
    signal: AbortSignal,
  ): Promise<ActionResult | void> | ActionResult | void;
  event?(name: string, data: unknown): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
export type PluginFactory = (context: Context) => Promise<Plugin> | Plugin;
