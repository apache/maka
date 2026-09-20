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

import {
  Component,
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CheckboxInput,
  CheckboxList,
  CheckboxListItem,
  Divider,
  EmptyState,
  FormLayout,
  HStack,
  Icon,
  IconButton,
  InputGroup,
  InputGroupText,
  Kbd,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  NumberInput,
  RadioList,
  RadioListItem,
  Selector,
  SelectorOption,
  SideNavItem,
  SideNavSection,
  Spinner,
  Stack,
  StackItem,
  StatusDot,
  Switch,
  Text,
  TextArea,
  TextInput,
  Tooltip,
  VStack,
} from '@astryxdesign/core';

/** Stable owner props for a frame-wide overlay contribution. */
export interface MakaClientShellOverlayProps {}

/** Stable owner props for an additive sidebar footer contribution. */
export interface MakaClientSidebarFooterProps {
  readonly collapsed: boolean;
}

/** Stable owner props for one plugin-owned Settings navigation control. */
export interface MakaClientSettingsNavigationProps {
  readonly activePage: string;
  readonly compact: boolean;
  readonly selectPage: (page: string) => void;
}

/** Stable owner props for one plugin-owned Settings page. */
export interface MakaClientSettingsPageProps {
  readonly page: string;
  readonly close: () => void;
}

/** Stable owner props for actions in the active conversation context header. */
export interface MakaClientConversationHeaderActionProps {
  readonly sessionName: string;
}

/** Stable owner props for additive actions below an assistant turn. */
export interface MakaClientConversationTurnFooterProps {
  readonly turnId?: string;
  readonly live: boolean;
  readonly assistantText?: string;
}

/** Stable owner props for controls in the Composer's left toolbar. */
export interface MakaClientComposerToolbarProps {
  readonly disabled: boolean;
  readonly streaming: boolean;
  readonly hasSession: boolean;
}

/** Stable owner props for a keyed Tool detail renderer. */
export interface MakaClientToolDetailProps {
  readonly callId: string;
  readonly toolName: string;
  readonly status: 'running' | 'completed' | 'errored' | 'interrupted';
  readonly args?: unknown;
  readonly result?: unknown;
}

/**
 * Public Client Slot contract table. Extensions may declaration-merge their
 * own child Slot names into this interface before declaring them from a
 * registered parent component.
 */
export interface MakaClientSlotMap {
  'shell.overlay': {
    kind: 'list';
    scope: 'root';
    owner: MakaClientShellOverlayProps;
  };
  'sidebar.footer': {
    kind: 'list';
    scope: 'root';
    owner: MakaClientSidebarFooterProps;
  };
  'settings.navigation': {
    kind: 'list';
    scope: 'root';
    owner: MakaClientSettingsNavigationProps;
  };
  'settings.page': {
    kind: 'keyed';
    scope: 'root';
    owner: MakaClientSettingsPageProps;
  };
  'conversation.header.actions': {
    kind: 'list';
    scope: 'session';
    owner: MakaClientConversationHeaderActionProps;
  };
  'conversation.turn.footer': {
    kind: 'list';
    scope: 'session';
    owner: MakaClientConversationTurnFooterProps;
  };
  'conversation.composer.toolbar': {
    kind: 'list';
    scope: 'session-maybe';
    owner: MakaClientComposerToolbarProps;
  };
  'conversation.tool.detail': {
    kind: 'keyed';
    scope: 'session';
    owner: MakaClientToolDetailProps;
  };
}

export type MakaClientSlotKind = 'single' | 'list' | 'keyed' | 'chain';
export type MakaClientSlotScope = 'root' | 'session-maybe' | 'session';

export interface MakaClientSlotEntryDef {
  readonly kind: MakaClientSlotKind;
  readonly scope: MakaClientSlotScope;
  readonly owner?: object;
  readonly keyProps?: Record<string, object>;
}

export type MakaClientSlotSpec<Entry extends MakaClientSlotEntryDef = MakaClientSlotEntryDef> = {
  readonly kind: Entry['kind'];
  readonly scope: Entry['scope'];
};

export type MakaClientChildrenDecl = {
  readonly [Name in keyof MakaClientSlotMap & string]?: MakaClientSlotSpec<
    MakaClientSlotMap[Name]
  >;
};

export interface MakaClientGlobalProps {}

export interface MakaClientSessionProps {
  readonly sessionId: string;
}

export interface MakaClientSessionMaybeProps {
  readonly sessionId: string | undefined;
}

export type MakaClientSlotOwner<Name extends keyof MakaClientSlotMap & string> =
  MakaClientSlotMap[Name] extends { owner: infer Owner extends object } ? Owner : object;

export type MakaClientSlotEntryKey<Name extends keyof MakaClientSlotMap & string> =
  MakaClientSlotMap[Name] extends { kind: 'keyed'; keyProps: infer KeyProps extends object }
    ? keyof KeyProps & string
    : string;

export type MakaClientSlotKeyProps<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name>,
> = MakaClientSlotMap[Name] extends { kind: 'keyed'; keyProps: infer KeyProps extends object }
  ? EntryKey extends keyof KeyProps
    ? KeyProps[EntryKey] extends object
      ? KeyProps[EntryKey]
      : never
    : never
  : object;

export type MakaClientSlotRuntimeProps<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
> = MakaClientSlotOwner<Name> &
  MakaClientSlotKeyProps<Name, EntryKey> &
  MakaClientGlobalProps &
  (MakaClientSlotMap[Name]['scope'] extends 'session'
    ? MakaClientSessionProps
    : MakaClientSlotMap[Name]['scope'] extends 'session-maybe'
      ? MakaClientSessionMaybeProps
      : object);

export interface MakaClientRenderSlotOptions<EntryKey extends string = string> {
  readonly entryKey?: EntryKey;
  readonly only?: string;
  readonly fallback?: ReactNode;
}

export interface MakaClientRenderChainOptions {
  readonly fallback?: ReactNode;
  /** Keep the fallback mounted, but hidden, while a chain contribution wins. */
  readonly overlay?: boolean;
}

export type MakaClientChainSelect<Owner extends object, Match> = (
  owner: Owner,
) => Match | null;

type MakaClientChainKeys<Names extends keyof MakaClientSlotMap & string> =
  Names extends unknown
    ? MakaClientSlotMap[Names]['kind'] extends 'chain'
      ? Names
      : never
    : never;

type MakaClientNonChainKeys<Names extends keyof MakaClientSlotMap & string> = Exclude<
  Names,
  MakaClientChainKeys<Names>
>;

export type MakaClientRenderSlots<Names extends keyof MakaClientSlotMap & string> = {
  renderSlot: <
    Name extends MakaClientNonChainKeys<Names>,
    EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
  >(
    name: Name,
    owner: MakaClientSlotOwner<Name> & MakaClientSlotKeyProps<Name, NoInfer<EntryKey>>,
    options?: MakaClientRenderSlotOptions<EntryKey>,
  ) => ReactNode;
} & ([MakaClientChainKeys<Names>] extends [never]
  ? object
  : {
      renderSlotChain: <Name extends MakaClientChainKeys<Names>>(
        name: Name,
        owner: MakaClientSlotOwner<Name>,
        options?: MakaClientRenderChainOptions,
      ) => ReactNode;
    });

type MakaClientMatchedProps<
  Name extends keyof MakaClientSlotMap & string,
  Match,
> = MakaClientSlotMap[Name]['kind'] extends 'chain' ? { readonly matched: Match } : object;

export type MakaClientComposedSlotProps<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name>,
  Children extends keyof MakaClientSlotMap & string,
  Match = never,
> = MakaClientSlotRuntimeProps<Name, EntryKey> &
  MakaClientRenderSlots<Children> &
  MakaClientMatchedProps<Name, Match>;

export type MakaClientSlotComponent<Props> = (props: Props) => ReactNode;

type MakaClientKindOptions<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name>,
  Match,
> = MakaClientSlotMap[Name]['kind'] extends 'keyed'
  ? { readonly key: EntryKey; readonly priority?: number }
  : MakaClientSlotMap[Name]['kind'] extends 'list'
    ? {
        readonly id: string;
        readonly order?: number;
        readonly priority?: number;
      }
    : MakaClientSlotMap[Name]['kind'] extends 'chain'
      ? {
          readonly select: MakaClientChainSelect<MakaClientSlotOwner<Name>, Match>;
          readonly priority?: number;
        }
      : { readonly priority?: number };

export type MakaClientSlotRegistrationOptions<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name>,
  Children extends MakaClientChildrenDecl,
  Match,
> = {
  readonly name: Name;
  readonly children?: Children;
  readonly registrant?: string;
} & MakaClientKindOptions<Name, EntryKey, Match>;

export interface MakaClientSlotRegistrar {
  register<
    Name extends keyof MakaClientSlotMap & string,
    const EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
    const Children extends MakaClientChildrenDecl = Record<never, never>,
    Match = never,
  >(
    options: MakaClientSlotRegistrationOptions<Name, EntryKey, Children, Match>,
    component: MakaClientSlotComponent<
      MakaClientComposedSlotProps<
        Name,
        NoInfer<EntryKey>,
        keyof NoInfer<Children> & keyof MakaClientSlotMap & string,
        NoInfer<Match>
      >
    >,
  ): () => void;
}

interface ErasedRegistrationOptions {
  readonly name: string;
  readonly key?: string;
  readonly id?: string;
  readonly order?: number;
  readonly priority?: number;
  readonly select?: (owner: never) => unknown;
  readonly children?: Readonly<Record<string, MakaClientSlotSpec>>;
  readonly registrant?: string;
}

export interface MakaClientStoredSlotEntry {
  readonly component: MakaClientSlotComponent<Record<string, unknown>>;
  readonly options: {
    readonly key?: string;
    readonly id?: string;
    readonly order?: number;
    readonly priority?: number;
  };
  readonly select?: ((owner: never) => unknown) | undefined;
  readonly children?: Readonly<Record<string, MakaClientSlotSpec>> | undefined;
  readonly registrant?: string | undefined;
  readonly sequence: number;
}

interface SlotRecord {
  spec: MakaClientSlotSpec | undefined;
  declaredBy: string | undefined;
  parent: string | undefined;
  entries: readonly MakaClientStoredSlotEntry[];
  version: number;
  readonly listeners: Set<() => void>;
}

export interface MakaClientLiveSlotNode {
  readonly name: string;
  readonly kind: MakaClientSlotKind;
  readonly scope: MakaClientSlotScope;
  readonly declaredBy?: string;
  readonly occupants: readonly {
    readonly registrant?: string;
    readonly key?: string;
    readonly id?: string;
    readonly priority: number;
    readonly active: boolean;
  }[];
  readonly children: readonly MakaClientLiveSlotNode[];
}

const EMPTY_ENTRIES: readonly MakaClientStoredSlotEntry[] = Object.freeze([]);

export const MAKA_CLIENT_NATIVE_SLOT_SPECS = Object.freeze({
  'shell.overlay': { kind: 'list', scope: 'root' },
  'sidebar.footer': { kind: 'list', scope: 'root' },
  'settings.navigation': { kind: 'list', scope: 'root' },
  'settings.page': { kind: 'keyed', scope: 'root' },
  'conversation.header.actions': { kind: 'list', scope: 'session' },
  'conversation.turn.footer': { kind: 'list', scope: 'session' },
  'conversation.composer.toolbar': { kind: 'list', scope: 'session-maybe' },
  'conversation.tool.detail': { kind: 'keyed', scope: 'session' },
} as const satisfies Readonly<Record<string, MakaClientSlotSpec>>);

/** React-free registry for one staged Client Plugin graph. */
export class MakaClientSlotCore implements MakaClientSlotRegistrar {
  readonly #records = new Map<string, SlotRecord>();
  readonly #dirty = new Set<SlotRecord>();
  readonly #abdicated = new WeakSet<MakaClientStoredSlotEntry>();
  #flushScheduled = false;
  #nextSequence = 0;

  constructor(specs: Readonly<Record<string, MakaClientSlotSpec>> = MAKA_CLIENT_NATIVE_SLOT_SPECS) {
    for (const [name, spec] of Object.entries(specs)) {
      const record = this.#record(name);
      record.spec = Object.freeze({ ...spec });
      record.declaredBy = '(maka desktop)';
    }
  }

  register<
    Name extends keyof MakaClientSlotMap & string,
    const EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
    const Children extends MakaClientChildrenDecl = Record<never, never>,
    Match = never,
  >(
    options: MakaClientSlotRegistrationOptions<Name, EntryKey, Children, Match>,
    component: MakaClientSlotComponent<
      MakaClientComposedSlotProps<
        Name,
        NoInfer<EntryKey>,
        keyof NoInfer<Children> & keyof MakaClientSlotMap & string,
        NoInfer<Match>
      >
    >,
  ): () => void;
  register(options: ErasedRegistrationOptions, component: unknown): () => void {
    const record = this.#records.get(options.name);
    if (!record?.spec) throw new Error(`Client Slot "${options.name}" is not declared`);
    if (typeof component !== 'function') {
      throw new Error(`Client Slot "${options.name}" component must be a function`);
    }

    const priority = options.priority ?? 0;
    const samePriority = (entry: MakaClientStoredSlotEntry): boolean =>
      (entry.options.priority ?? 0) === priority;
    switch (record.spec.kind) {
      case 'single':
        if (record.entries.some(samePriority)) {
          throw new Error(
            `Client Slot "${options.name}" already has a registration at priority ${priority}`,
          );
        }
        break;
      case 'list':
        if (options.id === undefined) {
          throw new Error(`Client list Slot "${options.name}" requires an id`);
        }
        if (
          record.entries.some(
            (entry) => entry.options.id === options.id && samePriority(entry),
          )
        ) {
          throw new Error(
            `Client Slot "${options.name}" already has id "${options.id}" at priority ${priority}`,
          );
        }
        break;
      case 'keyed':
        if (options.key === undefined) {
          throw new Error(`Client keyed Slot "${options.name}" requires a key`);
        }
        if (
          record.entries.some(
            (entry) => entry.options.key === options.key && samePriority(entry),
          )
        ) {
          throw new Error(
            `Client Slot "${options.name}" already has key "${options.key}" at priority ${priority}`,
          );
        }
        break;
      case 'chain':
        if (options.select === undefined) {
          throw new Error(`Client chain Slot "${options.name}" requires a selector`);
        }
        break;
    }

    for (const childName of Object.keys(options.children ?? {})) {
      const child = this.#records.get(childName);
      if (child?.spec) {
        throw new Error(
          `Client Slot "${childName}" is already declared by ${child.declaredBy ?? 'another entry'}`,
        );
      }
    }

    this.#nextSequence += 1;
    const entry: MakaClientStoredSlotEntry = Object.freeze({
      component: component as MakaClientSlotComponent<Record<string, unknown>>,
      options: Object.freeze({
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      }),
      ...(options.select === undefined ? {} : { select: options.select }),
      ...(options.children === undefined
        ? {}
        : { children: Object.freeze({ ...options.children }) }),
      ...(options.registrant === undefined ? {} : { registrant: options.registrant }),
      sequence: this.#nextSequence,
    });
    record.entries = Object.freeze(
      [...record.entries, entry].sort((left, right) =>
        (left.options.priority ?? 0) - (right.options.priority ?? 0) ||
        (left.options.order ?? 0) - (right.options.order ?? 0) ||
        left.sequence - right.sequence,
      ),
    );
    this.#markDirty(record);

    for (const [childName, childSpec] of Object.entries(options.children ?? {})) {
      const child = this.#record(childName);
      child.spec = Object.freeze({ ...childSpec });
      child.parent = options.name;
      child.declaredBy = options.registrant
        ? `${options.registrant} in "${options.name}"`
        : `an entry in "${options.name}"`;
      this.#markDirty(child);
    }

    let live = true;
    return () => {
      if (!live || !record.entries.includes(entry)) return;
      live = false;
      record.entries = Object.freeze(
        record.entries.filter((candidate) => candidate !== entry),
      );
      this.#markDirty(record);
      this.#releaseEntry(entry);
    };
  }

  isLive(entry: MakaClientStoredSlotEntry): boolean {
    for (const record of this.#records.values()) {
      if (record.entries.includes(entry)) return true;
    }
    return false;
  }

  entries(name: string): readonly MakaClientStoredSlotEntry[] {
    return this.#records.get(name)?.entries ?? EMPTY_ENTRIES;
  }

  activeEntries(name: string): readonly MakaClientStoredSlotEntry[] {
    const record = this.#records.get(name);
    if (!record?.spec) return EMPTY_ENTRIES;
    const active = record.entries.filter((entry) => !this.#abdicated.has(entry));
    if (record.spec.kind === 'chain') return active;
    const winners: MakaClientStoredSlotEntry[] = [];
    const occupied = new Set<string>();
    for (const entry of active) {
      const cell =
        record.spec.kind === 'keyed'
          ? `key:${entry.options.key ?? ''}`
          : record.spec.kind === 'list'
            ? `id:${entry.options.id ?? ''}`
            : 'single';
      if (occupied.has(cell)) continue;
      occupied.add(cell);
      winners.push(entry);
    }
    if (record.spec.kind === 'list') {
      winners.sort(
        (left, right) =>
          (left.options.order ?? 0) - (right.options.order ?? 0) ||
          left.sequence - right.sequence,
      );
    }
    return Object.freeze(winners);
  }

  spec<Name extends keyof MakaClientSlotMap & string>(
    name: Name,
  ): MakaClientSlotSpec<MakaClientSlotMap[Name]> | undefined {
    return this.#records.get(name)?.spec as
      | MakaClientSlotSpec<MakaClientSlotMap[Name]>
      | undefined;
  }

  specDynamic(name: string): MakaClientSlotSpec | undefined {
    return this.#records.get(name)?.spec;
  }

  getVersion(name: string): number {
    return this.#records.get(name)?.version ?? 0;
  }

  subscribe(name: string, listener: () => void): () => void {
    const record = this.#record(name);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  abdicate(name: string, entry: MakaClientStoredSlotEntry): void {
    if (this.#abdicated.has(entry)) return;
    this.#abdicated.add(entry);
    const record = this.#records.get(name);
    if (record) this.#markDirty(record);
  }

  inspect(): readonly MakaClientLiveSlotNode[] {
    const build = (name: string, ancestors: ReadonlySet<string>): MakaClientLiveSlotNode | null => {
      const record = this.#records.get(name);
      if (!record?.spec || ancestors.has(name)) return null;
      const nextAncestors = new Set(ancestors).add(name);
      const active = new Set(this.activeEntries(name));
      const children = [...this.#records.entries()]
        .filter(([, child]) => child.spec && child.parent === name)
        .flatMap(([childName]) => {
          const child = build(childName, nextAncestors);
          return child ? [child] : [];
        });
      return Object.freeze({
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...(record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy }),
        occupants: Object.freeze(
          record.entries.map((entry) =>
            Object.freeze({
              ...(entry.registrant === undefined ? {} : { registrant: entry.registrant }),
              ...(entry.options.key === undefined ? {} : { key: entry.options.key }),
              ...(entry.options.id === undefined ? {} : { id: entry.options.id }),
              priority: entry.options.priority ?? 0,
              active: active.has(entry),
            }),
          ),
        ),
        children: Object.freeze(children),
      });
    };
    return Object.freeze(
      [...this.#records.entries()]
        .filter(([, record]) => record.spec && !record.parent)
        .flatMap(([name]) => {
          const node = build(name, new Set());
          return node ? [node] : [];
        }),
    );
  }

  #releaseEntry(entry: MakaClientStoredSlotEntry): void {
    for (const childName of Object.keys(entry.children ?? {})) {
      const child = this.#records.get(childName);
      if (!child) continue;
      const descendants = child.entries;
      child.spec = undefined;
      child.declaredBy = undefined;
      child.parent = undefined;
      child.entries = EMPTY_ENTRIES;
      this.#markDirty(child);
      for (const descendant of descendants) this.#releaseEntry(descendant);
    }
  }

  #record(name: string): SlotRecord {
    let record = this.#records.get(name);
    if (!record) {
      record = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        entries: EMPTY_ENTRIES,
        version: 0,
        listeners: new Set(),
      };
      this.#records.set(name, record);
    }
    return record;
  }

  #markDirty(record: SlotRecord): void {
    record.version += 1;
    this.#dirty.add(record);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      const dirty = [...this.#dirty];
      this.#dirty.clear();
      for (const item of dirty) {
        for (const listener of [...item.listeners]) listener();
      }
    });
  }
}

interface SlotHostValue {
  readonly core: MakaClientSlotCore;
  readonly sessionId: string | undefined;
}

const MakaClientSlotHostContext = createContext<SlotHostValue | null>(null);

/** Whether a Slot currently has at least one live contribution. */
export function useMakaClientSlotOccupied(
  name: keyof MakaClientSlotMap & string,
): boolean {
  const host = useContext(MakaClientSlotHostContext);
  const core = host?.core;
  useSyncExternalStore(
    (listener) => core?.subscribe(name, listener) ?? (() => {}),
    () => core?.getVersion(name) ?? 0,
    () => core?.getVersion(name) ?? 0,
  );
  return (core?.activeEntries(name).length ?? 0) > 0;
}

export function MakaClientSlotProvider(props: {
  readonly core: MakaClientSlotCore;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <MakaClientSlotHostContext.Provider value={{ core: props.core, sessionId: undefined }}>
      {props.children}
    </MakaClientSlotHostContext.Provider>
  );
}

/** Bind nested Session Slots to the currently selected Session. */
export function MakaClientSessionScope(props: {
  readonly sessionId?: string;
  readonly children?: ReactNode;
}): ReactNode {
  const host = useContext(MakaClientSlotHostContext);
  if (!host) return props.children;
  return (
    <MakaClientSlotHostContext.Provider value={{ ...host, sessionId: props.sessionId }}>
      {props.children}
    </MakaClientSlotHostContext.Provider>
  );
}

function renderSlotsForEntry(
  entry: MakaClientStoredSlotEntry,
  host: SlotHostValue,
): Record<string, unknown> {
  if (!entry.children) return {};
  const assertOwned = (name: string): MakaClientSlotSpec => {
    if (!host.core.isLive(entry)) {
      throw new Error(`Cannot render Client Slot "${name}" from a disposed registration`);
    }
    const spec = entry.children?.[name];
    if (!spec) throw new Error(`Client Slot "${name}" is not declared by this registration`);
    return spec;
  };
  return {
    renderSlot: (
      name: string,
      owner: object,
      options?: MakaClientRenderSlotOptions,
    ): ReactNode => {
      const spec = assertOwned(name);
      if (spec.kind === 'chain') {
        throw new Error(`Client Slot "${name}" is chain-kind; use renderSlotChain`);
      }
      return <DynamicMakaClientSlotOutlet name={name} owner={owner} options={options} />;
    },
    renderSlotChain: (
      name: string,
      owner: object,
      options?: MakaClientRenderChainOptions,
    ): ReactNode => {
      const spec = assertOwned(name);
      if (spec.kind !== 'chain') {
        throw new Error(`Client Slot "${name}" is ${spec.kind}-kind; use renderSlot`);
      }
      return <DynamicMakaClientSlotOutlet name={name} owner={owner} options={options} />;
    },
  };
}

function propsForEntry(
  host: SlotHostValue,
  scope: MakaClientSlotScope,
  owner: object,
  entry: MakaClientStoredSlotEntry,
): Record<string, unknown> {
  const session =
    scope === 'session' || scope === 'session-maybe'
      ? { sessionId: host.sessionId }
      : {};
  return {
    ...session,
    ...renderSlotsForEntry(entry, host),
    ...owner,
  };
}

class MakaClientSlotBoundary extends Component<
  {
    readonly name: string;
    readonly entry: MakaClientStoredSlotEntry;
    readonly core: MakaClientSlotCore;
    readonly children?: ReactNode;
  },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.core.abdicate(this.props.name, this.props.entry);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function DynamicMakaClientSlotOutlet(props: {
  readonly name: string;
  readonly owner: object;
  readonly options?: MakaClientRenderSlotOptions & MakaClientRenderChainOptions;
}): ReactNode {
  const host = useContext(MakaClientSlotHostContext);
  const core = host?.core;
  useSyncExternalStore(
    (listener) => core?.subscribe(props.name, listener) ?? (() => {}),
    () => core?.getVersion(props.name) ?? 0,
    () => core?.getVersion(props.name) ?? 0,
  );
  if (!host || !core) return props.options?.fallback ?? null;

  const spec = core.specDynamic(props.name);
  if (!spec || (spec.scope === 'session' && host.sessionId === undefined)) {
    return props.options?.fallback ?? null;
  }
  const active = core.activeEntries(props.name);
  const renderEntry = (
    entry: MakaClientStoredSlotEntry,
    owner: object = props.owner,
  ): ReactNode => {
    const SlotComponent = entry.component;
    return (
      <MakaClientSlotBoundary
        key={entry.sequence}
        name={props.name}
        entry={entry}
        core={core}
      >
        <SlotComponent {...propsForEntry(host, spec.scope, owner, entry)} />
      </MakaClientSlotBoundary>
    );
  };

  if (spec.kind === 'single') {
    const entry = active[0];
    return entry ? renderEntry(entry) : (props.options?.fallback ?? null);
  }
  if (spec.kind === 'keyed') {
    const entry = active.find((candidate) => candidate.options.key === props.options?.entryKey);
    return entry ? renderEntry(entry) : (props.options?.fallback ?? null);
  }
  if (spec.kind === 'chain') {
    let elected: ReactNode = null;
    for (const entry of active) {
      let matched: unknown;
      try {
        matched = entry.select?.(props.owner as never) ?? null;
      } catch {
        core.abdicate(props.name, entry);
        continue;
      }
      if (matched === null) continue;
      elected = renderEntry(entry, { ...props.owner, matched });
      break;
    }
    if (props.options?.overlay) {
      return (
        <>
          <span style={{ display: elected === null ? 'contents' : 'none' }}>
            {props.options.fallback ?? null}
          </span>
          {elected}
        </>
      );
    }
    return elected ?? props.options?.fallback ?? null;
  }

  const rows = active.filter(
    (entry) => props.options?.only === undefined || entry.options.id === props.options.only,
  );
  if (rows.length === 0) return props.options?.fallback ?? null;
  return <>{rows.map((entry) => renderEntry(entry))}</>;
}

export interface MakaClientSlotOutletProps<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
> {
  readonly name: Name;
  readonly owner: MakaClientSlotOwner<Name> & MakaClientSlotKeyProps<Name, EntryKey>;
  readonly options?: MakaClientRenderSlotOptions<EntryKey> & MakaClientRenderChainOptions;
}

/** Render one native or recursively declared typed Client Slot. */
export function MakaClientSlotOutlet<
  Name extends keyof MakaClientSlotMap & string,
  EntryKey extends MakaClientSlotEntryKey<Name> = MakaClientSlotEntryKey<Name>,
>(props: MakaClientSlotOutletProps<Name, EntryKey>): ReactNode {
  return (
    <span data-maka-client-slot={props.name} style={{ display: 'contents' }}>
      <DynamicMakaClientSlotOutlet
        name={props.name}
        owner={props.owner}
        options={props.options}
      />
    </span>
  );
}

export { Fragment as MakaClientSlotFragment };

export type {
  MakaClientPluginApply,
  MakaClientPluginContext,
  MakaClientPluginSlots,
} from './client-plugin-runtime.js';

/** Compatibility-governed Astryx surface available to Client Plugins. */
export {
  Badge,
  Banner,
  Button,
  Card,
  CheckboxInput,
  CheckboxList,
  CheckboxListItem,
  Divider,
  EmptyState,
  FormLayout,
  HStack,
  Icon,
  IconButton,
  InputGroup,
  InputGroupText,
  Kbd,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  NumberInput,
  RadioList,
  RadioListItem,
  Selector,
  SelectorOption,
  SideNavItem,
  SideNavSection,
  Spinner,
  Stack,
  StackItem,
  StatusDot,
  Switch,
  Text,
  TextArea,
  TextInput,
  Tooltip,
  VStack,
};

/**
 * Exact value namespace exposed to trusted Client bundles. Keeping this list
 * explicit prevents the public plugin loader from inheriting private UI
 * exports when the internal package grows.
 */
export const MakaClientPluginSdkModule = Object.freeze({
  Badge,
  Banner,
  Button,
  Card,
  CheckboxInput,
  CheckboxList,
  CheckboxListItem,
  Divider,
  EmptyState,
  FormLayout,
  HStack,
  Icon,
  IconButton,
  InputGroup,
  InputGroupText,
  Kbd,
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
  MakaClientSlotFragment: Fragment,
  MakaClientSlotOutlet,
  NumberInput,
  RadioList,
  RadioListItem,
  Selector,
  SelectorOption,
  SideNavItem,
  SideNavSection,
  Spinner,
  Stack,
  StackItem,
  StatusDot,
  Switch,
  Text,
  TextArea,
  TextInput,
  Tooltip,
  VStack,
});
