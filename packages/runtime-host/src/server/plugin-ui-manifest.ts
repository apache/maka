import { posix } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';
import {
  EXTENSION_UI_SURFACES,
  type ExtensionUiSurface,
} from '@maka/runtime/extension-ui-contributions';

export interface UiPackageManifestContribution {
  readonly id: string;
  readonly surface: ExtensionUiSurface;
  readonly slot?: string;
  readonly slots: readonly string[];
  readonly priority: number;
  readonly document: string;
}

export interface UiPackageHostMethod {
  readonly name: string;
  readonly handler: string;
}

export interface UiPackageManifestHost {
  readonly entry: string;
  readonly methods: readonly UiPackageHostMethod[];
}

export interface UiPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ui: readonly UiPackageManifestContribution[];
  readonly host?: UiPackageManifestHost;
  readonly permissions: {
    readonly network: boolean;
    readonly hostState: boolean;
    readonly sessionAccess: boolean;
  };
}

export interface InstalledUiPackage {
  readonly extensionId: string;
  readonly root: string;
  readonly manifest: UiPackageManifest;
}

export class PluginUiManifestError extends Error {
  readonly name = 'PluginUiManifestError';
  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Decode client contributions from the unified Extension manifest. */
export function decodeUiPackageManifest(value: unknown): UiPackageManifest {
  const root = exactRecord(value, [
    'schemaVersion',
    'id',
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'displayName')
      ? ['displayName']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'description')
      ? ['description']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'dependencies')
      ? ['dependencies']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'configuration')
      ? ['configuration']
      : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'runtime') ? ['runtime'] : []),
    'ui',
  ]);
  const uiValue = root.ui as Record<string, unknown> | null;
  const candidate = uiValue;
  const record = exactRecord(
    uiValue,
    candidate && Object.hasOwn(candidate, 'host')
      ? ['contributions', 'host', 'permissions']
      : ['contributions', 'permissions'],
  );
  if (root.schemaVersion !== 1) throw invalidPackage('Extension schemaVersion must be 1');
  const id = requireId(root.id);
  if (
    !Array.isArray(record.contributions) ||
    record.contributions.length === 0 ||
    record.contributions.length > 16
  ) {
    throw invalidPackage('UI package must declare between 1 and 16 contributions');
  }
  const ids = new Set<string>();
  const ui = record.contributions.map((value, index): UiPackageManifestContribution => {
    const candidate = value as Record<string, unknown> | null;
    const item = exactRecord(value, [
      'id',
      'surface',
      'priority',
      'document',
      ...(candidate && Object.hasOwn(candidate, 'slot') ? ['slot'] : []),
      ...(candidate && Object.hasOwn(candidate, 'slots') ? ['slots'] : []),
    ]);
    const contributionId = boundedString(item.id, `ui[${index}].id`, 128);
    if (ids.has(contributionId))
      throw invalidPackage(`UI contribution id repeats: ${contributionId}`);
    ids.add(contributionId);
    if (!EXTENSION_UI_SURFACES.includes(item.surface as ExtensionUiSurface)) {
      throw invalidPackage(`UI contribution surface is invalid: ${String(item.surface)}`);
    }
    if (
      (item.surface === 'app.slot' &&
        (typeof item.slot !== 'string' ||
          !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(item.slot))) ||
      (item.surface !== 'app.slot' && item.slot !== undefined)
    ) {
      throw invalidPackage('UI contribution slot is invalid');
    }
    if (!Number.isSafeInteger(item.priority) || Math.abs(item.priority as number) > 10_000) {
      throw invalidPackage('UI contribution priority is invalid');
    }
    if (
      item.slots !== undefined &&
      (!Array.isArray(item.slots) ||
        item.slots.length > 32 ||
        item.slots.some(
          (slot) =>
            typeof slot !== 'string' ||
            !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(slot) ||
            Buffer.byteLength(slot, 'utf8') > 128,
        ) ||
        new Set(item.slots).size !== item.slots.length)
    ) {
      throw invalidPackage('UI contribution child slots are invalid');
    }
    return Object.freeze({
      id: contributionId,
      surface: item.surface as ExtensionUiSurface,
      ...(item.slot === undefined ? {} : { slot: item.slot as string }),
      slots: Object.freeze((item.slots as string[] | undefined) ?? []),
      priority: item.priority as number,
      document: packagePath(item.document, `ui[${index}].document`),
    });
  });
  const permissionRecord = record.permissions as Record<string, unknown> | null;
  const permissionKeys = ['network'];
  if (permissionRecord && Object.hasOwn(permissionRecord, 'hostState')) {
    permissionKeys.push('hostState');
  }
  if (permissionRecord && Object.hasOwn(permissionRecord, 'sessionAccess')) {
    permissionKeys.push('sessionAccess');
  }
  const permissions = exactRecord(record.permissions, permissionKeys);
  if (typeof permissions.network !== 'boolean')
    throw invalidPackage('UI network permission is invalid');
  if (permissions.hostState !== undefined && typeof permissions.hostState !== 'boolean')
    throw invalidPackage('UI Host state permission is invalid');
  if (permissions.sessionAccess !== undefined && typeof permissions.sessionAccess !== 'boolean')
    throw invalidPackage('UI Session access permission is invalid');
  if (permissions.sessionAccess === true && !ui.some(({ surface }) => surface === 'app.root')) {
    throw invalidPackage('Only a complete app.root UI may request Session access');
  }
  const host = record.host === undefined ? undefined : decodeHost(record.host);
  return Object.freeze({
    schemaVersion: 1,
    id,
    ui: Object.freeze(ui),
    ...(host ? { host } : {}),
    permissions: Object.freeze({
      network: permissions.network,
      hostState: permissions.hostState === true,
      sessionAccess: permissions.sessionAccess === true,
    }),
  });
}

function decodeHost(value: unknown): UiPackageManifestHost {
  const record = exactRecord(value, ['entry', 'methods']);
  const entry = packagePath(record.entry, 'host.entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('UI Host entry must be an .mjs file');
  if (!Array.isArray(record.methods) || record.methods.length === 0 || record.methods.length > 64) {
    throw invalidPackage('UI Host must declare between 1 and 64 methods');
  }
  const names = new Set<string>();
  const methods = record.methods.map((value, index) => {
    const method = exactRecord(value, ['name', 'handler']);
    const name = boundedString(method.name, `host.methods[${index}].name`, 128);
    const handler = boundedString(method.handler, `host.methods[${index}].handler`, 128);
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(handler)
    ) {
      throw invalidPackage('UI Host method name or handler is invalid');
    }
    if (names.has(name)) throw invalidPackage(`UI Host method repeats: ${name}`);
    names.add(name);
    return Object.freeze({ name, handler });
  });
  return Object.freeze({ entry, methods: Object.freeze(methods) });
}

function packagePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return path;
}

function requireId(value: unknown): string {
  const id = boundedString(value, 'id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('UI package id is invalid');
  return id;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\r\n\0]/u.test(value)
  )
    throw invalidPackage(`UI package ${label} is invalid`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidPackage('UI package record is invalid');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalidPackage('UI package record fields are invalid');
  }
  return record;
}

function invalidPackage(message: string, cause?: unknown): PluginUiManifestError {
  return new PluginUiManifestError('invalid_package', message, { cause });
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
