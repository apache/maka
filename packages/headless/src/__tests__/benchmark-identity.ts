/**
 * Read the benchmark identity the way the host entrypoints do — at run time,
 * from `harbor/benchmark-identity.json`.
 *
 * Not imported as a module: `resolveJsonModule` would copy the file into
 * `dist`, which is the one place it must never be — and it is why this helper
 * exists at all rather than the tests importing the harbor loader. The tests
 * that assert the invariant live in `harness-ab-manifest.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCHMARK_IDENTITY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../harbor/benchmark-identity.json',
);

export interface FrozenTaskTree {
  readonly taskIds: readonly string[];
  readonly taskTreeFingerprint: string;
}

export interface BenchmarkIdentity {
  readonly terminalBench21: FrozenTaskTree & {
    readonly upstreamRepositoryUrl: string;
    readonly revision: string;
  };
  readonly deepSwe: {
    readonly upstreamRepositoryUrl: string;
    readonly revision: string;
    readonly subset30: FrozenTaskTree;
    readonly full113: FrozenTaskTree;
  };
}

export const BENCHMARK_IDENTITY = JSON.parse(
  readFileSync(BENCHMARK_IDENTITY_PATH, 'utf8'),
) as BenchmarkIdentity;

/** The build output a graded arm gets mounted — compiled tests included. */
export const MOUNTED_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
