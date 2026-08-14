import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { JsonObject } from './experiment.js';
import type { NormalizedUsage } from './result.js';

export const MAKA_RUNTIME_ARTIFACT_PATH = '/logs/artifacts/maka-runtime-host';
export const MAKA_SUBJECT_STDOUT_PATH = '/logs/artifacts/maka-subject.stdout.txt';
export const MAKA_SUBJECT_STDERR_PATH = '/logs/artifacts/maka-subject.stderr.txt';

interface CapturedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface MakaRuntimeArtifactManifest {
  readonly schemaVersion: 'maka.eval.runtime_artifacts.v1';
  readonly reason: 'settled' | 'signal';
  readonly capturedAt: number;
  readonly files: readonly CapturedFile[];
}

export async function recoverMakaRuntimeUsage(input: { readonly trialPath: string }): Promise<
  | {
      readonly usage: NormalizedUsage;
      readonly costUsd: number;
      readonly artifact: JsonObject;
    }
  | undefined
> {
  const path = join(
    resolve(input.trialPath),
    'artifacts',
    'logs',
    'artifacts',
    'maka-runtime-host',
    'runtime.sqlite',
  );
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    const attempts = readUsageRecords(database, 'usage_model_call_attempts');
    const legacy = readUsageRecords(database, 'usage_llm_calls');
    const missingAttempts = attempts.filter((record) => record.usageBasis === 'missing').length;
    const inputTokens = sumRecords(attempts, 'inputTokens') + sumRecords(legacy, 'inputTokens');
    const outputTokens = sumRecords(attempts, 'outputTokens') + sumRecords(legacy, 'outputTokens');
    const cacheReadTokens =
      sumRecords(attempts, 'cacheReadInputTokens') +
      legacy.reduce(
        (total, record) =>
          total + count(record.cacheHitInputTokens ?? record.cachedInputTokens ?? 0),
        0,
      );
    const cacheWriteTokens =
      sumRecords(attempts, 'cacheWriteInputTokens') + sumRecords(legacy, 'cacheWriteInputTokens');
    const reasoningTokens =
      sumRecords(attempts, 'reasoningTokens') + sumRecords(legacy, 'reasoningTokens');
    if (inputTokens + outputTokens === 0) return undefined;
    const confirmedAttempts =
      attempts.filter((record) => record.usageBasis !== 'missing').length + legacy.length;
    const usageComplete = missingAttempts === 0;
    return {
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens,
      },
      costUsd: [...attempts, ...legacy].reduce(
        (total, record) => total + nonnegative(record.costUsd ?? 0),
        0,
      ),
      artifact: {
        kind: 'maka-runtime-usage-recovery',
        path: 'artifacts/logs/artifacts/maka-runtime-host/runtime.sqlite',
        usageComplete,
        confirmedAttempts,
        missingAttempts,
        tokenBasis: usageComplete ? 'complete' : 'lower-bound',
        costBasis: usageComplete ? 'complete' : 'lower-bound',
      },
    };
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

export async function captureMakaRuntimeArtifacts(input: {
  readonly stateRoot: string;
  readonly destinationRoot: string;
  readonly reason: MakaRuntimeArtifactManifest['reason'];
  readonly now?: () => number;
}): Promise<MakaRuntimeArtifactManifest> {
  const stateRoot = resolve(input.stateRoot);
  const destinationRoot = resolve(input.destinationRoot);
  const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const sourcePath = join(stateRoot, 'runtime.sqlite');
    const destinationPath = join(stagingRoot, 'runtime.sqlite');
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(source, destinationPath);
    } finally {
      source.close();
    }
    const snapshot = new DatabaseSync(destinationPath);
    try {
      snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
    await rm(`${destinationPath}-wal`, { force: true });
    await rm(`${destinationPath}-shm`, { force: true });
    await chmod(destinationPath, 0o600);

    for (const name of ['runtime-host-candidate.log', 'runtime-policy.json']) {
      const source = join(stateRoot, name);
      try {
        const metadata = await stat(source);
        if (!metadata.isFile()) continue;
        const destination = join(stagingRoot, name);
        await copyFile(source, destination);
        await chmod(destination, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const files = await Promise.all(
      ['runtime.sqlite', 'runtime-host-candidate.log', 'runtime-policy.json'].map((name) =>
        describeFile(join(stagingRoot, name), name),
      ),
    );
    const manifest: MakaRuntimeArtifactManifest = {
      schemaVersion: 'maka.eval.runtime_artifacts.v1',
      reason: input.reason,
      capturedAt: (input.now ?? Date.now)(),
      files: files.filter((file): file is CapturedFile => file !== null),
    };
    await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await mkdir(dirname(destinationRoot), { recursive: true, mode: 0o700 });
    await rm(destinationRoot, { recursive: true, force: true });
    await rename(stagingRoot, destinationRoot);
    return manifest;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeMakaArtifactCollectionError(
  destinationRoot: string,
  error: unknown,
): Promise<void> {
  const root = resolve(destinationRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, 'collection-error.json'),
    `${JSON.stringify({
      schemaVersion: 'maka.eval.runtime_artifact_error.v1',
      errorCode: safeErrorCode(error),
      message: safeErrorMessage(error),
    })}\n`,
    { mode: 0o600 },
  );
}

async function describeFile(path: string, name: string): Promise<CapturedFile | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return {
      path: basename(name),
      bytes: metadata.size,
      sha256: `sha256:${hash.digest('hex')}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safeErrorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message).subarray(0, 1024).toString();
}

function readUsageRecords(
  database: DatabaseSync,
  table: 'usage_model_call_attempts' | 'usage_llm_calls',
): ReadonlyArray<Record<string, unknown>> {
  return (
    database.prepare(`SELECT record_json FROM ${table}`).all() as Array<{
      record_json: string;
    }>
  ).map(({ record_json }) => {
    const value = JSON.parse(record_json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Runtime usage record is invalid');
    }
    return value as Record<string, unknown>;
  });
}

function sumRecords(records: ReadonlyArray<Record<string, unknown>>, field: string): number {
  return records.reduce((total, record) => total + count(record[field] ?? 0), 0);
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Runtime usage token count is invalid');
  }
  return Number(value);
}

function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Runtime usage cost is invalid');
  }
  return value;
}
