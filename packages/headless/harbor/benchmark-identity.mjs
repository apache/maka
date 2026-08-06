/**
 * Which benchmarks these runs are, loaded on the host and never in a container.
 *
 * A graded arm executes this package's build output, so anything compiled into
 * `dist` is readable from inside the container being scored. A benchmark's
 * pinned revision, upstream URL and task list are exactly what turns scoring
 * into retrieval: in the #1970 run an arm read the revision out of the mount,
 * fetched the task's reference solution from the public repository at that
 * revision, and recorded a pass that measured lookup. So the identity lives
 * here, beside the host-only entrypoints that need it, and never in `src`.
 *
 * `agent-repo-mount.ts` mounts one file out of this directory per arm, and
 * this is not it. `harness-ab-manifest.test.ts` holds that to be true.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const identityPath = join(dirname(fileURLToPath(import.meta.url)), 'benchmark-identity.json');

/** @type {{ terminalBench21: { upstreamRepositoryUrl: string, revision: string, taskTreeFingerprint: string, taskIds: string[] }, deepSwe: { upstreamRepositoryUrl: string, revision: string, subset30: { taskIds: string[], taskTreeFingerprint: string }, full113: { taskIds: string[], taskTreeFingerprint: string } } }} */
export const BENCHMARK_IDENTITY = JSON.parse(readFileSync(identityPath, 'utf8'));

export const TERMINAL_BENCH_2_1 = BENCHMARK_IDENTITY.terminalBench21;
export const DEEP_SWE = BENCHMARK_IDENTITY.deepSwe;
