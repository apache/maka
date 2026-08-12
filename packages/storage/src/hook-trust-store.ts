import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  HOOK_TRUST_VERSION,
  createDefaultHookTrust,
  type HookSource,
  type HookTrustFile,
  type HookTrustRecord,
} from '@maka/core/hooks';

const MAX_TRUST_BYTES = 1_048_576;
const MAX_RECORDS = 4_096;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface HookTrustStore {
  get(): Promise<HookTrustFile>;
  trust(record: HookTrustRecord): Promise<HookTrustFile>;
  revoke(definitionHash: string): Promise<HookTrustFile>;
}

export function createHookTrustStore(stateRoot: string): HookTrustStore {
  return new FileHookTrustStore(join(stateRoot, 'hook-trust.json'));
}

export function normalizeHookTrust(value: unknown): HookTrustFile {
  const root = exactRecord(value, ['version', 'trustedDefinitions'], 'Hook trust');
  if (root.version !== HOOK_TRUST_VERSION) {
    throw new Error(`Unsupported Hook trust version: ${String(root.version)}`);
  }
  if (!Array.isArray(root.trustedDefinitions) || root.trustedDefinitions.length > MAX_RECORDS) {
    throw new Error(`trustedDefinitions must contain at most ${MAX_RECORDS} records`);
  }
  const seen = new Set<string>();
  const records = root.trustedDefinitions.map((value, index) => {
    const label = `trustedDefinitions[${index}]`;
    const record = exactRecord(
      value,
      ['definitionHash', 'source', 'projectIdentity', 'trustedAt'],
      label,
    );
    if (typeof record.definitionHash !== 'string' || !HASH_PATTERN.test(record.definitionHash)) {
      throw new Error(`${label}.definitionHash is invalid`);
    }
    if (seen.has(record.definitionHash)) throw new Error(`Duplicate trusted definition hash`);
    seen.add(record.definitionHash);
    if (record.source !== 'user' && record.source !== 'project') {
      throw new Error(`${label}.source is invalid`);
    }
    if (
      typeof record.projectIdentity !== 'string' ||
      !record.projectIdentity ||
      record.projectIdentity.length > 8_192
    ) {
      throw new Error(`${label}.projectIdentity is invalid`);
    }
    if (!Number.isFinite(record.trustedAt) || (record.trustedAt as number) < 0) {
      throw new Error(`${label}.trustedAt is invalid`);
    }
    return {
      definitionHash: record.definitionHash as `sha256:${string}`,
      source: record.source as HookSource,
      projectIdentity: record.projectIdentity,
      trustedAt: record.trustedAt as number,
    };
  });
  return { version: HOOK_TRUST_VERSION, trustedDefinitions: records };
}

class FileHookTrustStore implements HookTrustStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  get(): Promise<HookTrustFile> {
    return this.serial(() => this.read());
  }

  trust(record: HookTrustRecord): Promise<HookTrustFile> {
    const normalizedRecord = normalizeHookTrust({
      version: HOOK_TRUST_VERSION,
      trustedDefinitions: [record],
    }).trustedDefinitions[0]!;
    return this.serial(async () => {
      const current = await this.read();
      const next = normalizeHookTrust({
        version: HOOK_TRUST_VERSION,
        trustedDefinitions: [
          ...current.trustedDefinitions.filter(
            (candidate) => candidate.definitionHash !== normalizedRecord.definitionHash,
          ),
          normalizedRecord,
        ],
      });
      await this.write(next);
      return next;
    });
  }

  revoke(definitionHash: string): Promise<HookTrustFile> {
    return this.serial(async () => {
      const current = await this.read();
      const next: HookTrustFile = {
        version: HOOK_TRUST_VERSION,
        trustedDefinitions: current.trustedDefinitions.filter(
          (record) => record.definitionHash !== definitionHash,
        ),
      };
      await this.write(next);
      return next;
    });
  }

  private async read(): Promise<HookTrustFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createDefaultHookTrust();
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_TRUST_BYTES) {
      throw new Error('Hook trust file exceeds 1 MiB');
    }
    return normalizeHookTrust(JSON.parse(text));
  }

  private async write(value: HookTrustFile): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    const tempPath = join(dir, `.hook-trust-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (process.platform !== 'win32') await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      if (process.platform !== 'win32') await chmod(this.path, 0o600);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
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

function exactRecord(
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
