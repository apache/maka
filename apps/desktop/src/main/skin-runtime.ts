import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, posix } from 'node:path';
import { unzipSync } from 'fflate';

const SKIN_SCHEMA_VERSION = 1;
const SKIN_WORLD_ID = 1004;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 128;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 4 * 1024 * 1024;
const STATE_FILE = 'state.json';

const ALLOWED_PERMISSIONS = new Set([
  'dom',
  'canvas',
  'audio',
  'storage',
]);

export type SkinPermission = 'dom' | 'canvas' | 'audio' | 'storage';

export interface SkinManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  styles?: string;
  entry?: string;
  preview?: string;
  permissions: SkinPermission[];
}

export interface InstalledSkin {
  manifest: SkinManifest;
  active: boolean;
}

export interface SkinRuntimeSnapshot {
  activeSkinId: string | null;
  installed: InstalledSkin[];
  safeMode: boolean;
  recoveredFromFailedActivation: boolean;
  lastError: string | null;
}

interface SkinRuntimeState {
  activeSkinId: string | null;
  activationPending: boolean;
  lastError: string | null;
}

export interface SkinWebContents {
  insertCSS(css: string, options?: { cssOrigin?: 'author' | 'user' }): Promise<string>;
  removeInsertedCSS(key: string): Promise<void>;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean,
  ): Promise<unknown>;
  isDestroyed(): boolean;
  on(event: 'did-finish-load' | 'destroyed', listener: () => void): this;
}

export interface SkinRuntime {
  readonly rootDir: string;
  attach(webContents: SkinWebContents): void;
  list(): Promise<SkinRuntimeSnapshot>;
  installFromFile(archivePath: string): Promise<SkinRuntimeSnapshot>;
  activate(id: string): Promise<SkinRuntimeSnapshot>;
  disable(): Promise<SkinRuntimeSnapshot>;
}

export class SkinRuntimeError extends Error {
  constructor(
    readonly code:
      | 'invalid-archive'
      | 'invalid-manifest'
      | 'already-installed'
      | 'not-installed'
      | 'activation-failed',
    message: string,
  ) {
    super(message);
    this.name = 'SkinRuntimeError';
  }
}

export function createSkinRuntime(options: {
  rootDir: string;
  safeMode?: boolean;
}): SkinRuntime {
  const rootDir = options.rootDir;
  const installedDir = join(rootDir, 'installed');
  const safeMode = options.safeMode === true;
  let webContents: SkinWebContents | null = null;
  let insertedCssKey: string | null = null;
  let initialized = false;
  let recoveredFromFailedActivation = false;
  let state: SkinRuntimeState = {
    activeSkinId: null,
    activationPending: false,
    lastError: null,
  };
  let mutation = Promise.resolve();

  async function initialize(): Promise<void> {
    if (initialized) return;
    await mkdir(installedDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(join(rootDir, STATE_FILE), 'utf8')) as Partial<SkinRuntimeState>;
      state = {
        activeSkinId: typeof parsed.activeSkinId === 'string' ? parsed.activeSkinId : null,
        activationPending: parsed.activationPending === true,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      // First launch and corrupt state both fall back to the safe empty state.
    }
    if (state.activationPending) {
      recoveredFromFailedActivation = true;
      state = {
        activeSkinId: null,
        activationPending: false,
        lastError: 'Maka disabled the previous skin because its activation did not finish.',
      };
      await persistState();
    }
    initialized = true;
  }

  async function persistState(): Promise<void> {
    await mkdir(rootDir, { recursive: true });
    const path = join(rootDir, STATE_FILE);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  }

  async function readInstalledManifests(): Promise<SkinManifest[]> {
    await initialize();
    const entries = await readdir(installedDir, { withFileTypes: true });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const value = JSON.parse(
            await readFile(join(installedDir, entry.name, 'manifest.json'), 'utf8'),
          );
          return parseSkinManifest(value);
        } catch {
          return null;
        }
      }));
    return manifests
      .filter((manifest): manifest is SkinManifest => manifest !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function snapshot(): Promise<SkinRuntimeSnapshot> {
    const manifests = await readInstalledManifests();
    return {
      activeSkinId: safeMode ? null : state.activeSkinId,
      installed: manifests.map((manifest) => ({
        manifest,
        active: !safeMode && manifest.id === state.activeSkinId,
      })),
      safeMode,
      recoveredFromFailedActivation,
      lastError: state.lastError,
    };
  }

  async function clearRendererSkin(): Promise<void> {
    const target = webContents;
    if (!target || target.isDestroyed()) {
      insertedCssKey = null;
      return;
    }
    await target.executeJavaScriptInIsolatedWorld(SKIN_WORLD_ID, [{
      code: `(() => {
        const current = globalThis.__makaSkinRuntime;
        try { current?.dispose?.(); } catch (error) { console.error('[maka-skin] dispose failed', error); }
        delete globalThis.__makaSkinRuntime;
        document.documentElement.removeAttribute('data-maka-skin');
      })()`,
      url: 'maka-skin://runtime/deactivate.js',
    }]).catch(() => undefined);
    if (insertedCssKey) {
      const key = insertedCssKey;
      insertedCssKey = null;
      await target.removeInsertedCSS(key).catch(() => undefined);
    }
  }

  async function applyActiveSkin(): Promise<void> {
    await initialize();
    await clearRendererSkin();
    if (safeMode || !state.activeSkinId) return;
    const target = webContents;
    if (!target || target.isDestroyed()) return;

    const skinDir = join(installedDir, state.activeSkinId);
    const manifest = parseSkinManifest(
      JSON.parse(await readFile(join(skinDir, 'manifest.json'), 'utf8')),
    );
    state.activationPending = true;
    state.lastError = null;
    await persistState();

    try {
      const assets = await readSkinAssets(skinDir);
      if (manifest.styles) {
        const stylesheet = await readBoundedText(
          join(skinDir, manifest.styles),
          MAX_STYLESHEET_BYTES,
          'Skin stylesheet',
        );
        insertedCssKey = await target.insertCSS(
          inlineStylesheetAssets(stylesheet, manifest.styles, assets),
          { cssOrigin: 'user' },
        );
      }
      if (manifest.entry) {
        const source = await readBoundedText(
          join(skinDir, manifest.entry),
          MAX_SCRIPT_BYTES,
          'Skin script',
        );
        const result = await target.executeJavaScriptInIsolatedWorld(
          SKIN_WORLD_ID,
          [{
            code: buildSkinActivationScript(manifest, source, assets),
            url: `maka-skin://${manifest.id}/${manifest.entry}`,
          }],
        ) as { ok?: boolean; error?: string } | undefined;
        if (!result?.ok) {
          throw new Error(result?.error ?? 'Skin entry did not finish activation.');
        }
      } else {
        await target.executeJavaScriptInIsolatedWorld(SKIN_WORLD_ID, [{
          code: `document.documentElement.setAttribute('data-maka-skin', ${JSON.stringify(manifest.id)}); ({ ok: true })`,
          url: `maka-skin://${manifest.id}/activate.js`,
        }]);
      }
      state.activationPending = false;
      state.lastError = null;
      await persistState();
    } catch (error) {
      await clearRendererSkin();
      const message = errorMessage(error);
      state = {
        activeSkinId: null,
        activationPending: false,
        lastError: message,
      };
      await persistState();
      throw new SkinRuntimeError('activation-failed', message);
    }
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutation.then(operation, operation);
    mutation = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    rootDir,
    attach(target) {
      webContents = target;
      target.on('did-finish-load', () => {
        void serialize(applyActiveSkin).catch((error) => {
          console.error('[maka-skin] failed to apply after renderer load:', error);
        });
      });
      target.on('destroyed', () => {
        if (webContents === target) webContents = null;
        insertedCssKey = null;
      });
    },
    list: () => serialize(snapshot),
    installFromFile: (archivePath) => serialize(async () => {
      await initialize();
      const archive = await readFile(archivePath);
      if (archive.byteLength > MAX_ARCHIVE_BYTES) {
        throw new SkinRuntimeError('invalid-archive', 'Skin archive is larger than 32 MiB.');
      }
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(new Uint8Array(archive));
      } catch {
        throw new SkinRuntimeError('invalid-archive', 'The selected file is not a valid .maka-skin archive.');
      }
      const normalizedFiles = normalizeArchiveFiles(files);
      const manifestBytes = normalizedFiles.get('manifest.json');
      if (!manifestBytes) {
        throw new SkinRuntimeError('invalid-manifest', 'Skin archive does not contain manifest.json.');
      }
      let manifestValue: unknown;
      try {
        manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes));
      } catch {
        throw new SkinRuntimeError('invalid-manifest', 'Skin manifest is not valid JSON.');
      }
      const manifest = parseSkinManifest(manifestValue);
      assertManifestFiles(manifest, normalizedFiles);
      const destination = join(installedDir, manifest.id);
      try {
        await readFile(join(destination, 'manifest.json'));
        throw new SkinRuntimeError('already-installed', `Skin “${manifest.name}” is already installed.`);
      } catch (error) {
        if (error instanceof SkinRuntimeError) throw error;
      }

      const staging = join(rootDir, `.install-${randomUUID()}`);
      await mkdir(staging, { recursive: true });
      try {
        for (const [relativePath, bytes] of normalizedFiles) {
          const output = join(staging, ...relativePath.split('/'));
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, bytes);
        }
        await rename(staging, destination);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      return snapshot();
    }),
    activate: (id) => serialize(async () => {
      await initialize();
      if (safeMode) {
        throw new SkinRuntimeError('activation-failed', 'Skins are disabled by safe mode.');
      }
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
        throw new SkinRuntimeError('not-installed', 'Invalid skin id.');
      }
      try {
        await readFile(join(installedDir, id, 'manifest.json'));
      } catch {
        throw new SkinRuntimeError('not-installed', `Skin “${id}” is not installed.`);
      }
      state.activeSkinId = id;
      await persistState();
      await applyActiveSkin();
      return snapshot();
    }),
    disable: () => serialize(async () => {
      await initialize();
      state = {
        activeSkinId: null,
        activationPending: false,
        lastError: null,
      };
      await persistState();
      await clearRendererSkin();
      return snapshot();
    }),
  };
}

export function parseSkinManifest(value: unknown): SkinManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin manifest must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== SKIN_SCHEMA_VERSION) {
    throw new SkinRuntimeError('invalid-manifest', 'Unsupported skin manifest schemaVersion.');
  }
  const id = readRequiredString(candidate.id, 'id');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin id must contain 2–64 lowercase letters, numbers, dots, dashes, or underscores.');
  }
  const name = readRequiredString(candidate.name, 'name', 80);
  const version = readRequiredString(candidate.version, 'version', 40);
  const styles = readOptionalSafePath(candidate.styles, 'styles');
  const entry = readOptionalSafePath(candidate.entry, 'entry');
  const preview = readOptionalSafePath(candidate.preview, 'preview');
  if (!styles && !entry) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin manifest must define styles or entry.');
  }
  const rawPermissions = candidate.permissions ?? [];
  if (!Array.isArray(rawPermissions) || rawPermissions.some((item) => typeof item !== 'string' || !ALLOWED_PERMISSIONS.has(item))) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin permissions contain an unsupported capability.');
  }
  const permissions = [...new Set(rawPermissions)] as SkinPermission[];
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    ...(readOptionalString(candidate.description, 240) ? { description: readOptionalString(candidate.description, 240) } : {}),
    ...(readOptionalString(candidate.author, 80) ? { author: readOptionalString(candidate.author, 80) } : {}),
    ...(styles ? { styles } : {}),
    ...(entry ? { entry } : {}),
    ...(preview ? { preview } : {}),
    permissions,
  };
}

export function normalizeArchiveFiles(files: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const entries = Object.entries(files).filter(([name]) => !name.endsWith('/'));
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new SkinRuntimeError('invalid-archive', 'Skin archive has an invalid number of files.');
  }
  let expandedBytes = 0;
  const safeEntries = entries.map(([rawPath, bytes]) => {
    expandedBytes += bytes.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new SkinRuntimeError('invalid-archive', 'Skin archive expands beyond 64 MiB.');
    }
    const slashPath = rawPath.replaceAll('\\', '/');
    if (
      slashPath.startsWith('/') ||
      /^[a-z]:/i.test(slashPath) ||
      slashPath.split('/').some((part) => part === '..')
    ) {
      throw new SkinRuntimeError('invalid-archive', 'Skin archive contains an unsafe path.');
    }
    const normalized = posix.normalize(slashPath).replace(/^\.\//, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new SkinRuntimeError('invalid-archive', 'Skin archive contains an unsafe path.');
    }
    return [normalized, bytes] as const;
  });

  const directManifest = safeEntries.some(([path]) => path === 'manifest.json');
  const manifestPaths = safeEntries.filter(([path]) => path.endsWith('/manifest.json'));
  let wrapper = '';
  if (!directManifest) {
    if (manifestPaths.length !== 1) {
      throw new SkinRuntimeError('invalid-manifest', 'Skin archive must contain one manifest.json.');
    }
    wrapper = manifestPaths[0]![0].slice(0, -'manifest.json'.length);
    if (wrapper.slice(0, -1).includes('/')) {
      throw new SkinRuntimeError('invalid-manifest', 'manifest.json must be at the archive root or one wrapper folder deep.');
    }
  }

  const normalized = new Map<string, Uint8Array>();
  for (const [path, bytes] of safeEntries) {
    if (wrapper && !path.startsWith(wrapper)) {
      if (path === '.DS_Store' || path.startsWith('__MACOSX/')) continue;
      throw new SkinRuntimeError('invalid-archive', 'Skin archive mixes files outside its wrapper folder.');
    }
    const stripped = wrapper ? path.slice(wrapper.length) : path;
    if (!stripped || stripped === '.DS_Store' || stripped.startsWith('__MACOSX/')) continue;
    if (normalized.has(stripped)) {
      throw new SkinRuntimeError('invalid-archive', 'Skin archive contains duplicate file paths.');
    }
    normalized.set(stripped, bytes);
  }
  return normalized;
}

function assertManifestFiles(manifest: SkinManifest, files: Map<string, Uint8Array>): void {
  for (const [label, path] of [
    ['stylesheet', manifest.styles],
    ['entry', manifest.entry],
    ['preview', manifest.preview],
  ] as const) {
    if (path && !files.has(path)) {
      throw new SkinRuntimeError('invalid-manifest', `Skin ${label} file “${path}” is missing.`);
    }
  }
  if (manifest.styles && files.get(manifest.styles)!.byteLength > MAX_STYLESHEET_BYTES) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin stylesheet is larger than 4 MiB.');
  }
  if (manifest.entry) {
    const entry = files.get(manifest.entry)!;
    if (entry.byteLength > MAX_SCRIPT_BYTES) {
      throw new SkinRuntimeError('invalid-manifest', 'Skin entry is larger than 2 MiB.');
    }
    const source = new TextDecoder().decode(entry);
    if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) {
      throw new SkinRuntimeError('invalid-manifest', 'Skin entry must be self-contained and cannot import modules.');
    }
  }
}

async function readSkinAssets(skinDir: string): Promise<Record<string, string>> {
  const assetsDir = join(skinDir, 'assets');
  const result: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(assetsDir, { recursive: true, withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentPath = 'parentPath' in entry && typeof entry.parentPath === 'string'
      ? entry.parentPath
      : assetsDir;
    const absolutePath = join(parentPath, entry.name);
    const relativePath = posix.join(
      'assets',
      absolutePath.slice(assetsDir.length + 1).split('\\').join('/'),
    );
    const bytes = await readFile(absolutePath);
    result[relativePath] = `data:${mimeType(relativePath)};base64,${bytes.toString('base64')}`;
  }
  return result;
}

export function inlineStylesheetAssets(
  stylesheet: string,
  stylesheetPath: string,
  assets: Record<string, string>,
): string {
  const baseDir = posix.dirname(stylesheetPath);
  return stylesheet.replace(
    /url\(\s*(['"]?)(?!data:|https?:|maka-skin:|#)([^'")]+)\1\s*\)/gi,
    (match, _quote: string, rawPath: string) => {
      const resolved = posix.normalize(posix.join(baseDir, rawPath.trim())).replace(/^\.\//, '');
      const asset = assets[resolved];
      return asset ? `url("${asset}")` : match;
    },
  );
}

export function buildSkinActivationScript(
  manifest: SkinManifest,
  entrySource: string,
  assets: Record<string, string>,
): string {
  const transformed = transformSkinModule(entrySource);
  return `(async () => {
    try {
      const previous = globalThis.__makaSkinRuntime;
      try { previous?.dispose?.(); } catch (error) { console.error('[maka-skin] previous dispose failed', error); }

      const manifest = Object.freeze(${JSON.stringify(manifest)});
      const assetTable = Object.freeze(${JSON.stringify(assets)});
      const disposers = [];
      const overlay = document.createElement('div');
      overlay.dataset.makaSkinOverlay = manifest.id;
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
      disposers.push(() => overlay.remove());

      const api = Object.freeze({
        manifest,
        overlay,
        assets: Object.freeze({
          url(path) {
            const normalized = String(path).replace(/^\\.\\//, '');
            return assetTable[normalized] ?? null;
          },
          list() { return Object.keys(assetTable); },
        }),
        parts: Object.freeze({
          one(name) { return document.querySelector('[data-maka-part="' + CSS.escape(String(name)) + '"]'); },
          all(name) { return [...document.querySelectorAll('[data-maka-part="' + CSS.escape(String(name)) + '"]')]; },
        }),
        events: Object.freeze({
          on(type, handler) {
            const eventName = 'maka:' + String(type);
            const listener = (event) => handler(event.detail, event);
            window.addEventListener(eventName, listener);
            const off = () => window.removeEventListener(eventName, listener);
            disposers.push(off);
            return off;
          },
        }),
        storage: Object.freeze({
          get(key, fallback = null) {
            try {
              const raw = localStorage.getItem('maka-skin:' + manifest.id + ':' + String(key));
              return raw === null ? fallback : JSON.parse(raw);
            } catch { return fallback; }
          },
          set(key, value) {
            localStorage.setItem('maka-skin:' + manifest.id + ':' + String(key), JSON.stringify(value));
          },
          remove(key) {
            localStorage.removeItem('maka-skin:' + manifest.id + ':' + String(key));
          },
        }),
        log(...args) { console.info('[maka-skin:' + manifest.id + ']', ...args); },
      });

      const activate = (() => {
        ${transformed}
        return typeof activate === 'function' ? activate : null;
      })();
      if (!activate) throw new Error('entry.mjs must export an activate(api) function.');
      const skinDispose = await activate(api);
      if (typeof skinDispose === 'function') disposers.push(skinDispose);
      const dispose = () => {
        for (const disposer of disposers.splice(0).reverse()) {
          try { disposer(); } catch (error) { console.error('[maka-skin] dispose failed', error); }
        }
      };
      globalThis.__makaSkinRuntime = { dispose };
      document.documentElement.setAttribute('data-maka-skin', manifest.id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`;
}

function transformSkinModule(source: string): string {
  if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin entry must be self-contained and cannot import modules.');
  }
  if (/\bexport\s+default\b/.test(source)) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin entry must use a named activate export.');
  }
  return source
    .replace(/\bexport\s+(async\s+function\s+activate\b)/g, '$1')
    .replace(/\bexport\s+(function\s+activate\b)/g, '$1')
    .replace(/\bexport\s+((?:const|let|var)\s+activate\b)/g, '$1')
    .replace(/\bexport\s*\{\s*activate\s*(?:as\s+activate\s*)?\}\s*;?/g, '');
}

function readRequiredString(value: unknown, field: string, maxLength = 64): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new SkinRuntimeError('invalid-manifest', `Skin manifest field “${field}” is invalid.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new SkinRuntimeError('invalid-manifest', 'Skin manifest contains an invalid optional string.');
  }
  return value.trim() || undefined;
}

function readOptionalSafePath(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SkinRuntimeError('invalid-manifest', `Skin manifest field “${field}” must be a path.`);
  }
  const slashPath = value.replaceAll('\\', '/');
  if (
    !slashPath ||
    slashPath.startsWith('/') ||
    /^[a-z]:/i.test(slashPath) ||
    slashPath.split('/').some((part) => part === '..')
  ) {
    throw new SkinRuntimeError('invalid-manifest', `Skin manifest field “${field}” contains an unsafe path.`);
  }
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new SkinRuntimeError('invalid-manifest', `Skin manifest field “${field}” contains an unsafe path.`);
  }
  return normalized;
}

async function readBoundedText(path: string, maxBytes: number, label: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds its size limit.`);
  return bytes.toString('utf8');
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.avif': return 'image/avif';
    case '.gif': return 'image/gif';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    default: return 'application/octet-stream';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
