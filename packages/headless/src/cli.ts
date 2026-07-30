#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAgentRunDocument } from '@maka/runtime';
import type { Config, ResultRecord, Task } from './contracts.js';
import { runAutonomousTask, runAutonomousTaskWithStorage } from './autonomous-agent-loop.js';
import {
  authenticateHeadlessStorageReader,
  isStorageRootAuthorityError,
  openHeadlessStorageForRead,
  openHeadlessStorageForWrite,
  type HeadlessStorageReader,
} from './headless-storage.js';
import { harborCommand } from './harbor-cli.js';
import { runMatrix, type ExperimentSpec } from './matrix.js';
import { planMatrixRetry, readMatrixPriorRecords } from './matrix-resume.js';
import {
  buildMakaAheTargetSnapshot,
  readMakaAheHarborOfficialResult,
  writeMakaAheEvidenceExport,
  type MakaAheOfficialResultOverlay,
  type MakaAheAgentRunEvidenceByTaskRun,
  type MakaAheAgentRunEvidenceSource,
  type MakaAheSessionMessagesByTaskRun,
} from './ahe-evidence-export.js';
import { writeTaskRunExport } from './result-export.js';
import { backendNeedsIsolation, validateTaskVerification } from './runner.js';
import { runTaskOnce, runTaskOnceWithStorage } from './task-agent-controller.js';
import { isTerminalTaskRunStatus } from './task-contracts.js';
import { taskRunLocator } from './task-run-identity.js';
import type { TaskRunProjection } from './task-run-projection.js';
import { inspectTaskRun, renderTaskRunInspectTree } from './task-run-inspect.js';
import { readResults, toComparisonTable, writeResults } from './results.js';

/**
 * Reject a spec we cannot run safely or score trustworthily, BEFORE any run
 * starts — eval is a hard boundary, not a per-cell failure:
 *  - a model-backed backend would execute the config under test on the host
 *    with no isolation; the CLI wires only "fake", while real backends use the
 *    programmatic API with explicit realBackendIsolation;
 *  - a task with no declared grading boundary cannot be scored honestly.
 */
function validateEvalSpec(spec: ExperimentSpec): void {
  for (const config of spec.configs) {
    if (backendNeedsIsolation(config.backend)) {
      throw new Error(
        `config "${config.id}": backend "${config.backend}" requires an isolated executor and programmatic backend wiring — the CLI only wires "fake" by default`,
      );
    }
  }
  for (const task of spec.tasks) {
    validateTaskVerification(task);
  }
}

async function evalCommand(args: string[]): Promise<number> {
  let positional: string[];
  let flags: Record<string, string>;
  try {
    ({ positional, flags } = parseArgs(args, ['out']));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: maka eval run <spec.json> [--out <dir>]`);
    return 1;
  }
  const specPath = positional[0];
  if (!specPath) {
    console.error('usage: maka eval run <spec.json> [--out <dir>]');
    return 1;
  }

  // Read + parse + validate up front: an unreadable file, malformed JSON, a
  // refused backend, or a missing grading boundary is an infrastructure error,
  // not benchmark data — fail before running anything.
  let spec: ExperimentSpec;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8')) as ExperimentSpec;
    validateEvalSpec(spec);
  } catch (error) {
    console.error(`maka eval run: ${(error as Error).message}`);
    return 1;
  }

  const specDir = dirname(resolve(specPath));
  // Task workspace fixtures are resolved relative to the spec file so a
  // spec is portable alongside its fixtures.
  const tasks = spec.tasks.map((task) => ({
    ...task,
    workspaceDir: isAbsolute(task.workspaceDir)
      ? task.workspaceDir
      : resolve(specDir, task.workspaceDir),
  }));
  const outDir = resolve(flags.out ?? 'maka-headless-out');

  console.log(`running ${spec.configs.length} config(s) × ${tasks.length} task(s)…`);
  const records = await runMatrix(
    { configs: spec.configs, tasks },
    {
      storageRoot: join(outDir, 'runs'),
      // registerBackends omitted → runExperiment defaults to the inert
      // FakeBackend, the only backend this build runs.
    },
    (r) =>
      console.log(
        `  ${mark(r.passed, r.error)} ${r.taskId} × ${r.configId}${r.error ? ` — ${r.error}` : ''}`,
      ),
  );

  const resultsPath = join(outDir, 'results.jsonl');
  const tablePath = join(outDir, 'comparison.md');
  const table = toComparisonTable(records);
  await writeResults(resultsPath, records);
  await writeFile(tablePath, table, 'utf8');
  console.log(`\n${table}\nresults: ${resultsPath}\ntable:   ${tablePath}`);
  // Honest exit code: a run that THREW (missing workspace, unknown backend, …)
  // carries an `error` and never produced a trustworthy pass/fail — that is an
  // infrastructure failure, exit non-zero. A run that completed and merely
  // failed its verification is valid benchmark data and stays exit 0.
  return records.some((r) => r.error) ? 1 : 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error('usage: maka eval compare <results.jsonl>');
    return 1;
  }
  process.stdout.write(toComparisonTable(await readResults(path)));
  return 0;
}

async function taskCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'run') return taskRunCommand(rest);
  if (subcommand === 'inspect') return taskInspectCommand(rest);
  if (subcommand === 'resume') return taskResumeCommand(rest);
  if (subcommand === 'retry-failed') return taskRetryFailedCommand(rest);
  if (subcommand === 'export') return taskExportCommand(rest);
  printTaskUsage();
  return 1;
}

async function taskRunCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(
      args,
      ['task', 'config', 'out', 'task-run-id', 'max-attempts'],
      ['autonomous', 'include-events'],
    );
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval task-run run <spec.json> --task <id> --config <id> [--out <dir>] [--task-run-id <id>] [--autonomous] [--max-attempts N]`,
    );
    return 1;
  }
  const specPath = parsed.positional[0];
  if (!specPath || !parsed.flags.task || !parsed.flags.config) {
    console.error(
      'usage: maka eval task-run run <spec.json> --task <id> --config <id> [--out <dir>] [--task-run-id <id>] [--autonomous] [--max-attempts N]',
    );
    return 1;
  }

  try {
    const spec = await loadSpec(specPath);
    const task = requireTask(spec.tasks, parsed.flags.task);
    const config = requireConfig(spec.configs, parsed.flags.config);
    validateRunnableCell(config, task);
    const outDir = resolve(parsed.flags.out ?? 'maka-headless-out');
    const common = {
      storageRoot: join(outDir, 'runs'),
      ...(parsed.flags['task-run-id'] ? { taskRunId: parsed.flags['task-run-id'] } : {}),
    };
    const run = parsed.bools.autonomous
      ? await runAutonomousTask(config, task, {
          ...common,
          budget: {
            maxAttempts: positiveInt(parsed.flags['max-attempts'] ?? '1', '--max-attempts'),
          },
        })
      : await runTaskOnce(config, task, common);
    await appendResultRecord(outDir, run.resultRecord);
    const exportDir = join(outDir, 'exports', taskRunLocator(run.taskRunId));
    await writeTaskRunExport(exportDir, run.projection, {
      includeEvents: parsed.bools['include-events'],
    });
    console.log(
      `taskRunId: ${run.taskRunId}\nstatus: ${run.projection.status}\nexport: ${exportDir}`,
    );
    return run.resultRecord.error ? 1 : 0;
  } catch (error) {
    console.error(`maka eval task-run run: ${(error as Error).message}`);
    return 1;
  }
}

async function taskInspectCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, ['store'], ['json']);
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval task-run inspect <taskRunId> --store <out>/runs [--json]`,
    );
    return 1;
  }
  const taskRunId = parsed.positional[0];
  if (!taskRunId || !parsed.flags.store) {
    console.error('usage: maka eval task-run inspect <taskRunId> --store <out>/runs [--json]');
    return 1;
  }
  const storageRoot = resolve(parsed.flags.store);
  return runTaskRunStorageCommand('inspect', storageRoot, async () => {
    const storage = await openHeadlessStorageForRead(storageRoot);
    const document = await inspectTaskRun(
      {
        taskRunStore: storage.taskRunStore,
        agentRunStore: storage.executionStores.agentRunStore,
        runtimeEventStore: storage.executionStores.runtimeEventStore,
      },
      taskRunId,
    );
    if (parsed.bools.json) {
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else {
      process.stdout.write(renderTaskRunInspectTree(document));
    }
    return 0;
  });
}

async function taskExportCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, ['store', 'out'], ['include-events']);
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval task-run export <taskRunId> --store <out>/runs --out <dir> [--include-events]`,
    );
    return 1;
  }
  const taskRunId = parsed.positional[0];
  if (!taskRunId || !parsed.flags.store || !parsed.flags.out) {
    console.error(
      'usage: maka eval task-run export <taskRunId> --store <out>/runs --out <dir> [--include-events]',
    );
    return 1;
  }
  const storageRoot = resolve(parsed.flags.store);
  return runTaskRunStorageCommand('export', storageRoot, async () => {
    const storage = await openHeadlessStorageForRead(storageRoot);
    const projection = await storage.taskRunStore.project(taskRunId);
    const result = await writeTaskRunExport(resolve(parsed.flags.out), projection, {
      includeEvents: parsed.bools['include-events'],
    });
    console.log(`export: ${result.files.taskRunJson}`);
    return 0;
  });
}

async function aheCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'export') return aheExportCommand(rest);
  console.error('maka eval ahe commands:\n');
  console.error(
    '  maka eval ahe export <taskRunId...> --store <out>/runs --repo <repo-root> --out <dir> [--run-id <id>] [--source-label <label>] [--harbor-trial-dir <dir>] [--include-events]',
  );
  return 1;
}

async function aheExportCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(
      args,
      ['store', 'repo', 'out', 'run-id', 'source-label', 'harbor-trial-dir'],
      ['include-events'],
    );
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval ahe export <taskRunId...> --store <out>/runs --repo <repo-root> --out <dir> [--run-id <id>] [--source-label <label>] [--harbor-trial-dir <dir>] [--include-events]`,
    );
    return 1;
  }
  if (
    parsed.positional.length === 0 ||
    !parsed.flags.store ||
    !parsed.flags.repo ||
    !parsed.flags.out
  ) {
    console.error(
      'usage: maka eval ahe export <taskRunId...> --store <out>/runs --repo <repo-root> --out <dir> [--run-id <id>] [--source-label <label>] [--harbor-trial-dir <dir>] [--include-events]',
    );
    return 1;
  }
  try {
    const storeRoot = resolve(parsed.flags.store);
    const storage = await openHeadlessStorageForRead(storeRoot);
    const projections = await Promise.all(
      parsed.positional.map((taskRunId) => storage.taskRunStore.project(taskRunId)),
    );
    const officialResults = await aheOfficialResultsForCli(projections, {
      storeRoot,
      harborTrialDir: parsed.flags['harbor-trial-dir']
        ? resolve(parsed.flags['harbor-trial-dir'])
        : undefined,
    });
    const sessionMessages = await aheSessionMessagesForCli(projections, storage);
    const agentRunEvidence = await aheAgentRunEvidenceForCli(
      projections,
      storage,
      parsed.bools['include-events'] === true,
    );
    const snapshot = await buildMakaAheTargetSnapshot({
      repoRoot: resolve(parsed.flags.repo),
      sourceLabel: parsed.flags['source-label'],
    });
    const result = await writeMakaAheEvidenceExport(resolve(parsed.flags.out), {
      snapshot,
      projections,
      runId: parsed.flags['run-id'],
      includeEvents: parsed.bools['include-events'],
      officialResults,
      sessionMessages,
      agentRunEvidence,
    });
    console.log(`targetSnapshot: ${result.files.targetSnapshotJson}`);
    console.log(`harnessResults: ${result.files.harnessResultsJson}`);
    console.log(`traceIndex: ${result.files.traceIndexJson}`);
    return 0;
  } catch (error) {
    console.error(`maka eval ahe export: ${(error as Error).message}`);
    return 1;
  }
}

async function aheOfficialResultsForCli(
  projections: readonly TaskRunProjection[],
  options: { storeRoot: string; harborTrialDir?: string },
): Promise<Record<string, MakaAheOfficialResultOverlay> | undefined> {
  if (options.harborTrialDir && projections.length !== 1) {
    throw new Error('--harbor-trial-dir currently supports exactly one taskRunId');
  }
  const overlays: Record<string, MakaAheOfficialResultOverlay> = {};
  if (options.harborTrialDir) {
    const projection = projections[0]!;
    overlays[projection.taskRunId] = await readMakaAheHarborOfficialResult(
      options.harborTrialDir,
      projection,
    );
    return overlays;
  }

  if (projections.length === 1) {
    const inferred = resolve(options.storeRoot, '..', '..', '..');
    if (await looksLikeHarborTrialDir(inferred)) {
      const projection = projections[0]!;
      overlays[projection.taskRunId] = await readMakaAheHarborOfficialResult(inferred, projection);
      return overlays;
    }
  }
  return undefined;
}

async function looksLikeHarborTrialDir(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, 'result.json'));
    await stat(join(dir, 'verifier', 'reward.txt'));
    return true;
  } catch {
    return false;
  }
}

async function aheSessionMessagesForCli(
  projections: readonly TaskRunProjection[],
  storage: HeadlessStorageReader,
): Promise<MakaAheSessionMessagesByTaskRun | undefined> {
  storage = authenticateHeadlessStorageReader(storage);
  const messagesByTaskRun: Record<string, readonly unknown[]> = {};
  for (const projection of projections) {
    if (!projection.sessionId) continue;
    try {
      const messages = await storage.executionStores.sessionStore.readMessages(
        projection.sessionId,
      );
      if (messages.length > 0) {
        messagesByTaskRun[projection.taskRunId] = messages;
      }
    } catch (error) {
      rethrowStorageAuthorityError(error);
    }
  }
  return Object.keys(messagesByTaskRun).length > 0 ? messagesByTaskRun : undefined;
}

async function aheAgentRunEvidenceForCli(
  projections: readonly TaskRunProjection[],
  storage: HeadlessStorageReader,
  includeRuntimeEvents: boolean,
): Promise<MakaAheAgentRunEvidenceByTaskRun | undefined> {
  storage = authenticateHeadlessStorageReader(storage);
  const runStore = storage.executionStores.agentRunStore;
  const runtimeEventStore = storage.executionStores.runtimeEventStore;
  const byTaskRun: Record<string, MakaAheAgentRunEvidenceSource[]> = {};
  for (const projection of projections) {
    const sources: MakaAheAgentRunEvidenceSource[] = [];
    const seen = new Set<string>();
    for (const evidence of projection.executionLineage) {
      const identity = evidence.execution;
      if (!identity?.sessionId || !identity.agentRunId) continue;
      const key = `${identity.sessionId}\u0000${identity.agentRunId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source: MakaAheAgentRunEvidenceSource = {
        sessionId: identity.sessionId,
        agentRunId: identity.agentRunId,
      };
      try {
        source.inspect = await inspectAgentRunDocument(runStore, runtimeEventStore, {
          sessionId: identity.sessionId,
          agentRunId: identity.agentRunId,
          isFatalReadError: isStorageRootAuthorityError,
        });
      } catch (error) {
        rethrowStorageAuthorityError(error);
        source.inspectError = errorMessage(error);
      }
      if (includeRuntimeEvents) {
        try {
          if (!runtimeEventStore.readImmutableRuntimeEvents) {
            source.runtimeEventsError =
              'RuntimeEventStore does not expose immutable Runtime Event reads';
          } else {
            source.runtimeEvents = await runtimeEventStore.readImmutableRuntimeEvents(
              identity.sessionId,
              identity.agentRunId,
            );
          }
        } catch (error) {
          rethrowStorageAuthorityError(error);
          source.runtimeEventsError = errorMessage(error);
        }
      }
      sources.push(source);
    }
    if (sources.length > 0) byTaskRun[projection.taskRunId] = sources;
  }
  return Object.keys(byTaskRun).length > 0 ? byTaskRun : undefined;
}

function rethrowStorageAuthorityError(error: unknown): void {
  if (isStorageRootAuthorityError(error)) throw error;
}

async function taskResumeCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, ['spec', 'out']);
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval task-run resume <taskRunId> --spec <spec.json> --out <dir>`,
    );
    return 1;
  }
  const taskRunId = parsed.positional[0];
  if (!taskRunId || !parsed.flags.spec || !parsed.flags.out) {
    console.error('usage: maka eval task-run resume <taskRunId> --spec <spec.json> --out <dir>');
    return 1;
  }
  try {
    const outDir = resolve(parsed.flags.out);
    const storage = await openHeadlessStorageForWrite(join(outDir, 'runs'));
    const store = storage.taskRunStore;
    const projection = await store.project(taskRunId);
    if (isTerminalTaskRunStatus(projection.status)) {
      console.error(
        `task run ${taskRunId} is terminal (${projection.status}); resume is unsupported`,
      );
      return 1;
    }
    if (projection.status !== 'needs_approval') {
      console.error(
        `task run ${taskRunId} is ${projection.status}; PR50 resume only supports parked needs_approval runs`,
      );
      return 1;
    }
    const spec = await loadSpec(parsed.flags.spec);
    const task = requireTask(spec.tasks, projection.taskId);
    const config = requireConfig(spec.configs, projection.configId);
    validateRunnableCell(config, task);
    if (projection.parked) {
      const resolvedAt = Date.now();
      await store.appendEvent(taskRunId, {
        type: 'task_inbox_item_resolved',
        id: randomUUID(),
        taskRunId,
        ts: resolvedAt,
        inboxItemId: projection.parked.inboxItemId,
        status: 'resolved',
        resolution: {
          decision: 'resume_requested',
          actorId: 'maka-eval-cli',
          resolvedAt,
          reason: 'resumed by maka eval task-run resume',
        },
      });
    }
    const attemptId = `${taskRunId}-attempt-${projection.attempts.length + 1}`;
    const run = await runTaskOnceWithStorage(
      config,
      task,
      {
        storageRoot: join(outDir, 'runs'),
        taskRunId,
        attemptId,
        createTaskRun: false,
      },
      storage,
    );
    await appendResultRecord(outDir, run.resultRecord);
    await writeTaskRunExport(join(outDir, 'exports', taskRunLocator(taskRunId)), run.projection);
    console.log(`resumed: ${taskRunId}\nstatus: ${run.projection.status}`);
    return run.resultRecord.error ? 1 : 0;
  } catch (error) {
    console.error(`maka eval task-run resume: ${(error as Error).message}`);
    return 1;
  }
}

async function taskRetryFailedCommand(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args, ['spec', 'out', 'only-taxonomy']);
  } catch (error) {
    console.error(
      `${(error as Error).message}\nusage: maka eval task-run retry-failed <results.jsonl|out-dir> --spec <spec.json> --out <dir> [--only-taxonomy name[,name]]`,
    );
    return 1;
  }
  const priorPath = parsed.positional[0];
  if (!priorPath || !parsed.flags.spec || !parsed.flags.out) {
    console.error(
      'usage: maka eval task-run retry-failed <results.jsonl|out-dir> --spec <spec.json> --out <dir> [--only-taxonomy name[,name]]',
    );
    return 1;
  }

  try {
    const spec = await loadSpec(parsed.flags.spec);
    const prior = await readMatrixPriorRecords(resolve(priorPath));
    const outDir = resolve(parsed.flags.out);
    const storage = await openHeadlessStorageForWrite(join(outDir, 'runs'));
    const onlyTaxonomy = parsed.flags['only-taxonomy']
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const plan = planMatrixRetry(spec.tasks, spec.configs, prior, {
      retryFailed: true,
      onlyTaxonomy,
    });
    const records: ResultRecord[] = [...prior];
    for (const decision of plan) {
      if (decision.action !== 'retry') {
        console.log(`skip ${decision.task.id} × ${decision.config.id}: ${decision.reason}`);
        continue;
      }
      validateRunnableCell(decision.config, decision.task);
      console.log(`retry ${decision.task.id} × ${decision.config.id}: ${decision.reason}`);
      const run = await runTaskOnceWithStorage(
        decision.config,
        decision.task,
        {
          storageRoot: join(outDir, 'runs'),
        },
        storage,
      );
      records.push(run.resultRecord);
      await writeTaskRunExport(
        join(outDir, 'exports', taskRunLocator(run.taskRunId)),
        run.projection,
      );
    }
    await writeResults(join(outDir, 'results.jsonl'), records);
    await writeFile(join(outDir, 'comparison.md'), toComparisonTable(records), 'utf8');
    return records.some((record) => record.error && !prior.includes(record)) ? 1 : 0;
  } catch (error) {
    console.error(`maka eval task-run retry-failed: ${(error as Error).message}`);
    return 1;
  }
}

function mark(passed: boolean, error?: string): string {
  if (error) return '⚠️';
  return passed ? '✅' : '❌';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTaskRunStorageCommand(
  command: 'inspect' | 'export',
  storageRoot: string,
  operation: () => Promise<number>,
): Promise<number> {
  try {
    return await operation();
  } catch (error) {
    if (!isStorageRootAuthorityError(error)) throw error;
    const message =
      error.code === 'root_not_found' ||
      error.code === 'root_unmarked' ||
      error.code === 'root_kind_mismatch'
        ? `The selected path is not a Headless task-run root: ${storageRoot}. Pass the <out>/runs directory created by a task run`
        : error.message;
    console.error(`maka eval task-run ${command}: ${message}`);
    return 1;
  }
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
  bools: Record<string, boolean>;
}

function parseArgs(args: string[], knownFlags: string[], boolFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (boolFlags.includes(name)) {
      bools[name] = true;
      continue;
    }
    if (!knownFlags.includes(name)) throw new Error(`unknown flag: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${arg} needs a value`);
    flags[name] = value;
    i++;
  }
  return { positional, flags, bools };
}

function printLegacyUsage(): void {
  console.error('maka-headless — headless agent runner\n');
  console.error(
    '  maka-headless eval <spec.json> [--out <dir>]   run configs × tasks, write results + table',
  );
  console.error('  maka-headless compare <results.jsonl>          print the comparison table');
  console.error(
    '  maka-headless task <command> ...               run, inspect, resume, retry, export task runs',
  );
  console.error(
    '  maka-headless ahe <command> ...                export AHE target snapshots and evidence',
  );
  console.error(
    '  maka-headless harbor <command> ...             run Harbor real-backend task/cell flows',
  );
}

function printUnifiedUsage(): void {
  console.error('maka eval — evaluation and autonomous task commands\n');
  console.error(
    '  maka eval run <spec.json> [--out <dir>]        run configs × tasks, write results + table',
  );
  console.error('  maka eval compare <results.jsonl>               print the comparison table');
  console.error(
    '  maka eval task-run <command> ...                run, inspect, resume, retry, export task runs',
  );
  console.error(
    '  maka eval ahe <command> ...                     export AHE target snapshots and evidence',
  );
  console.error(
    '  maka eval harbor <command> ...                  run Harbor real-backend task/cell flows',
  );
}

function printTaskUsage(): void {
  console.error('maka eval task-run commands:\n');
  console.error(
    '  maka eval task-run run <spec.json> --task <id> --config <id> [--out <dir>] [--task-run-id <id>] [--autonomous] [--max-attempts N]',
  );
  console.error('  maka eval task-run inspect <taskRunId> --store <out>/runs [--json]');
  console.error('  maka eval task-run resume <taskRunId> --spec <spec.json> --out <dir>');
  console.error(
    '  maka eval task-run retry-failed <results.jsonl|out-dir> --spec <spec.json> --out <dir> [--only-taxonomy name[,name]]',
  );
  console.error(
    '  maka eval task-run export <taskRunId> --store <out>/runs --out <dir> [--include-events]',
  );
}

/** Canonical router shared by `maka eval` and the legacy compatibility bin. */
export async function runMakaEvalCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return evalCommand(rest);
  if (cmd === 'compare') return compareCommand(rest);
  if (cmd === 'task-run') return taskCommand(rest);
  if (cmd === 'ahe') return aheCommand(rest);
  if (cmd === 'harbor') return harborCommand(rest);
  printUnifiedUsage();
  return cmd ? 1 : 0;
}

/** Translate the five supported legacy command families into the canonical tree. */
export function mapLegacyMakaHeadlessArgs(argv: string[]): string[] | null {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return [];
  if (cmd === 'eval') return ['run', ...rest];
  if (cmd === 'compare') return ['compare', ...rest];
  if (cmd === 'task') return ['task-run', ...rest];
  if (cmd === 'ahe') return ['ahe', ...rest];
  if (cmd === 'harbor') return ['harbor', ...rest];
  return null;
}

async function runLegacyMakaHeadlessCli(argv: string[]): Promise<number> {
  console.error('warning: maka-headless is deprecated; use `maka eval` instead');
  const mapped = mapLegacyMakaHeadlessArgs(argv);
  if (mapped === null || mapped.length === 0) {
    printLegacyUsage();
    return mapped === null ? 1 : 0;
  }
  return runMakaEvalCli(mapped);
}

async function loadSpec(specPath: string): Promise<ExperimentSpec> {
  const specFile = resolve(specPath);
  const spec = JSON.parse(await readFile(specFile, 'utf8')) as ExperimentSpec;
  const specDir = dirname(specFile);
  return {
    configs: spec.configs,
    tasks: spec.tasks.map((task) => ({
      ...task,
      workspaceDir: isAbsolute(task.workspaceDir)
        ? task.workspaceDir
        : resolve(specDir, task.workspaceDir),
    })),
  };
}

function requireTask(tasks: readonly Task[], id: string): Task {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`task not found: ${id}`);
  return task;
}

function requireConfig(configs: readonly Config[], id: string): Config {
  const config = configs.find((candidate) => candidate.id === id);
  if (!config) throw new Error(`config not found: ${id}`);
  return config;
}

function validateRunnableCell(config: Config, task: Task): void {
  if (backendNeedsIsolation(config.backend)) {
    throw new Error(
      `config "${config.id}": backend "${config.backend}" requires an isolated executor and programmatic backend wiring — the CLI only wires "fake" by default`,
    );
  }
  validateTaskVerification(task);
}

async function appendResultRecord(outDir: string, record: ResultRecord): Promise<void> {
  const path = join(outDir, 'results.jsonl');
  const records = await readResults(path).catch((error): ResultRecord[] => {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'ENOENT'
    )
      return [];
    throw error;
  });
  records.push(record);
  await writeResults(path, records);
  await writeFile(join(outDir, 'comparison.md'), toComparisonTable(records), 'utf8');
}

function positiveInt(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${flagName} must be a positive integer`);
  return value;
}

if (isMainModule()) {
  runLegacyMakaHeadlessCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
