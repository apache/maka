export type MakaThemePreference = 'light' | 'dark' | 'auto';
export type MakaResolvedTheme = 'light' | 'dark';

export interface MakaSkinManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  styles?: string;
  entry?: string;
  preview?: string;
  permissions: Array<'dom' | 'canvas' | 'audio' | 'storage'>;
}

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

export interface MakaSkinStyleHandle {
  update(css: string): void;
  dispose(): void;
}

export interface MakaSkinApi {
  readonly apiVersion: 1;
  readonly manifest: Readonly<MakaSkinManifest>;
  readonly overlay: HTMLDivElement;
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
    on(type: string, handler: (detail: unknown, event: Event) => void): () => void;
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
