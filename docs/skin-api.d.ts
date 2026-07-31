export type MakaThemePreference = 'light' | 'dark' | 'auto';
export type MakaResolvedTheme = 'light' | 'dark';

export interface MakaSkinManifest {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  styles?: string;
  entry?: string;
  preview?: string;
  permissions: MakaSkinPermission[];
  minimumApiVersion: number;
  requiredCapabilities: MakaSkinCapability[];
}

export type MakaSkinPermission =
  | 'dom'
  | 'canvas'
  | 'audio'
  | 'storage'
  | 'actions.navigation'
  | 'actions.task'
  | 'actions.submit'
  | 'actions.stop';

export type MakaSkinCapability =
  | 'appearance.v1'
  | 'parts.v1'
  | 'slots.v1'
  | 'events.semantic.v1'
  | 'actions.navigation.v1'
  | 'actions.task.v1'
  | 'actions.submit.v1'
  | 'actions.stop.v1';

export interface MakaAppearanceSnapshot {
  preference: MakaThemePreference;
  resolvedTheme: MakaResolvedTheme;
  palette: string;
  colorScheme: MakaResolvedTheme;
  forcedColors: boolean;
  prefersContrast: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

export interface MakaStateSnapshot {
  section: string;
  module?: string;
  hasActiveSession: boolean;
  streaming: boolean;
  modalOpen: boolean;
}

export interface MakaEnvironmentSnapshot extends MakaAppearanceSnapshot {
  locale: string;
  platform: string;
  viewport: Readonly<{ width: number; height: number }>;
  devicePixelRatio: number;
  touch: boolean;
}

export type MakaSkinPart =
  | 'app'
  | 'shell'
  | 'titlebar'
  | 'sidebar'
  | 'main'
  | 'detail-panel'
  | 'chat'
  | 'chat-header'
  | 'transcript'
  | 'composer'
  | 'composer-interactions'
  | 'settings'
  | 'settings-sidebar'
  | 'settings-content'
  | 'command-palette';

export type MakaSkinSlot =
  | 'chat-header-before'
  | 'chat-header-after'
  | 'transcript-before'
  | 'transcript-after'
  | 'composer-before'
  | 'composer-after';

export interface MakaSkinEventMap {
  'session.changed': { sessionId: string | null };
  'messages.changed': {
    sessionId: string | null;
    count: number;
    lastMessage?: Readonly<{ id: string; type: string }>;
  };
  'generation.changed': {
    sessionId: string | null;
    state: 'idle' | 'processing' | 'streaming' | 'tool' | 'waiting';
  };
  'tools.changed': {
    sessionId: string | null;
    tools: ReadonlyArray<Readonly<{ id: string; name: string; status: string }>>;
  };
  'interaction.changed': {
    sessionId: string | null;
    kind: 'permission' | 'question' | null;
    waiting: boolean;
  };
  state: MakaStateSnapshot;
  appearance: MakaAppearanceSnapshot;
}

export interface MakaSkinActionMap {
  'navigation.switch-session': {
    input: { sessionId: string };
    output: void;
  };
  'task.new': {
    input: Record<string, never>;
    output: void;
  };
  'composer.submit': {
    input: { text: string };
    output: void;
  };
  'generation.stop': {
    input: Record<string, never>;
    output: void;
  };
}

export interface MakaSkinStyleHandle {
  update(css: string): void;
  dispose(): void;
}

export interface MakaSkinApi {
  readonly apiVersion: 2;
  readonly manifest: Readonly<MakaSkinManifest>;
  readonly overlay: HTMLDivElement;
  readonly capabilities: {
    readonly all: readonly MakaSkinCapability[];
    has(name: MakaSkinCapability | string): boolean;
    require(name: MakaSkinCapability | string): void;
  };
  readonly permissions: {
    readonly all: readonly MakaSkinPermission[];
    has(name: MakaSkinPermission | string): boolean;
    require(name: MakaSkinPermission | string): void;
  };
  readonly assets: {
    url(path: string): string | null;
    list(): string[];
  };
  readonly parts: {
    readonly names: readonly MakaSkinPart[];
    one(name: MakaSkinPart | string): Element | null;
    all(name: MakaSkinPart | string): Element[];
    observe(
      name: MakaSkinPart | string,
      handler: (elements: readonly Element[]) => void,
    ): () => void;
    wait(name: MakaSkinPart | string, timeoutMs?: number): Promise<Element>;
  };
  readonly slots: {
    readonly names: readonly MakaSkinSlot[];
    one(name: MakaSkinSlot | string): Element | null;
    observe(name: MakaSkinSlot | string, handler: (slot: Element | null) => void): () => void;
    wait(name: MakaSkinSlot | string, timeoutMs?: number): Promise<Element>;
    mount(name: MakaSkinSlot | string): HTMLDivElement;
  };
  readonly appearance: {
    current(): MakaAppearanceSnapshot;
    onDidChange(handler: (snapshot: MakaAppearanceSnapshot) => void): () => void;
    readonly tokens: {
      get(name: `--${string}`): string;
      all(): Readonly<Record<`--${string}`, string>>;
      set(name: `--${string}`, value: string): void;
      setAll(values: Partial<Record<`--${string}`, string>>): void;
      reset(name: `--${string}`): void;
      resetAll(): void;
    };
  };
  readonly state: {
    current(): MakaStateSnapshot;
    onDidChange(handler: (snapshot: MakaStateSnapshot) => void): () => void;
  };
  readonly environment: {
    current(): MakaEnvironmentSnapshot;
    onDidChange(handler: (snapshot: MakaEnvironmentSnapshot) => void): () => void;
  };
  readonly styles: {
    add(css: string, id?: string): MakaSkinStyleHandle;
  };
  readonly events: {
    on<Type extends keyof MakaSkinEventMap>(
      type: Type,
      handler: (detail: MakaSkinEventMap[Type], event: Event) => void,
    ): () => void;
    on(type: string, handler: (detail: unknown, event: Event) => void): () => void;
  };
  readonly actions: {
    can<Type extends keyof MakaSkinActionMap>(name: Type): boolean;
    invoke<Type extends keyof MakaSkinActionMap>(
      name: Type,
      input: MakaSkinActionMap[Type]['input'],
    ): Promise<MakaSkinActionMap[Type]['output']>;
  };
  readonly lifecycle: {
    onDispose(handler: () => void): () => void;
  };
  readonly storage: {
    get<T>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    remove(key: string): void;
  };
  log(...args: unknown[]): void;
}

export type MakaSkinActivate = (
  api: MakaSkinApi,
) => void | (() => void) | Promise<void | (() => void)>;
