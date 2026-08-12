import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  HOOK_CONFIG_VERSION,
  createDefaultHookConfig,
  type HookCommandConfig,
  type HookConfigFile,
  type HookMatcherGroupConfig,
} from '@maka/core/hooks';

const MAX_CONFIG_BYTES = 1_048_576;
const MAX_HANDLERS = 128;
const MAX_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 8_192;
const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

export interface HookConfigStore {
  get(): Promise<HookConfigFile>;
  set(config: HookConfigFile): Promise<HookConfigFile>;
}

export function createHookConfigStore(stateRoot: string): HookConfigStore {
  return new FileHookConfigStore(join(stateRoot, 'hooks.json'));
}

export async function readHookConfigFile(path: string): Promise<HookConfigFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDefaultHookConfig();
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error('Hook config exceeds 1 MiB');
  }
  return normalizeHookConfig(JSON.parse(text));
}

export function normalizeHookConfig(value: unknown): HookConfigFile {
  const root = recordWithKeys(value, ['version', 'hooks'], 'Hook config');
  if (root.version !== HOOK_CONFIG_VERSION) {
    throw new Error(`Unsupported Hook config version: ${String(root.version)}`);
  }
  const hooks = recordWithKeys(root.hooks, ['PreToolUse'], 'hooks');
  const rawGroups = hooks.PreToolUse ?? [];
  if (!Array.isArray(rawGroups)) throw new Error('hooks.PreToolUse must be an array');

  const ids = new Set<string>();
  let handlerCount = 0;
  const groups: HookMatcherGroupConfig[] = rawGroups.map((rawGroup, groupIndex) => {
    const group = recordWithKeys(rawGroup, ['matcher', 'hooks'], `PreToolUse[${groupIndex}]`);
    const matcher = normalizeMatcher(group.matcher, groupIndex);
    if (!Array.isArray(group.hooks)) {
      throw new Error(`PreToolUse[${groupIndex}].hooks must be an array`);
    }
    const handlers = group.hooks.map((rawHandler, handlerIndex) => {
      handlerCount += 1;
      if (handlerCount > MAX_HANDLERS) {
        throw new Error(`Hook config exceeds ${MAX_HANDLERS} handlers`);
      }
      const handler = normalizeHandler(rawHandler, groupIndex, handlerIndex);
      if (ids.has(handler.id)) throw new Error(`Duplicate Hook handler id: ${handler.id}`);
      ids.add(handler.id);
      return handler;
    });
    return { matcher, hooks: handlers };
  });

  return {
    version: HOOK_CONFIG_VERSION,
    hooks: groups.length > 0 ? { PreToolUse: groups } : {},
  };
}

class FileHookConfigStore implements HookConfigStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  get(): Promise<HookConfigFile> {
    return this.serial(() => readHookConfigFile(this.path));
  }

  async set(config: HookConfigFile): Promise<HookConfigFile> {
    const normalized = normalizeHookConfig(config);
    return this.serial(async () => {
      await writePrivateJson(this.path, normalized, '.hooks-');
      return normalized;
    });
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizeMatcher(value: unknown, groupIndex: number): string {
  if (value === undefined) return '*';
  const matcher = boundedString(value, `PreToolUse[${groupIndex}].matcher`, 1_024);
  const tokens = matcher.split('|');
  if (
    tokens.some(
      (token) =>
        !token ||
        token.trim() !== token ||
        token.includes('\0') ||
        (token.includes('*') && !/^[^*]+\*$/u.test(token) && token !== '*'),
    )
  ) {
    throw new Error(`PreToolUse[${groupIndex}].matcher is invalid`);
  }
  return matcher;
}

function normalizeHandler(
  value: unknown,
  groupIndex: number,
  handlerIndex: number,
): HookCommandConfig {
  const label = `PreToolUse[${groupIndex}].hooks[${handlerIndex}]`;
  const handler = recordWithKeys(
    value,
    ['id', 'type', 'command', 'args', 'timeoutMs', 'enabled'],
    label,
  );
  const id = boundedString(handler.id, `${label}.id`, MAX_ID_LENGTH);
  if (handler.type !== 'command') throw new Error(`${label}.type must be command`);
  const command = boundedString(handler.command, `${label}.command`, MAX_STRING_LENGTH);
  if (!isAbsolute(command)) throw new Error(`${label}.command must be an absolute path`);
  const args = handler.args === undefined ? [] : normalizeArgs(handler.args, `${label}.args`);
  const timeoutMs = handler.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : handler.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < MIN_TIMEOUT_MS ||
    (timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error(`${label}.timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  const enabled = handler.enabled === undefined ? true : handler.enabled;
  if (typeof enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean`);
  return { id, type: 'command', command, args, timeoutMs: timeoutMs as number, enabled };
}

function normalizeArgs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${label} must be an array`);
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, MAX_STRING_LENGTH, true),
  );
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a valid string`);
  }
  return value;
}

function recordWithKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
  return record;
}

async function writePrivateJson(path: string, value: unknown, prefix: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  const tempPath = join(dir, `${prefix}${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
