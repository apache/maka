import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createExternalSubjectAdapter } from './external-subject.js';
import {
  createHarborExecutor,
  createPierExecutor,
  type HarnessExecutor,
} from './harness-executor.js';
import { openExperimentDirectory } from './experiment-directory.js';
import type { ExperimentSpec } from './experiment.js';
import { createMakaSubjectAdapter } from './maka-subject.js';
import { runExperiment, type ExperimentExecutor, type SubjectAdapter } from './runner.js';
import { parseExperimentSpec } from './spec.js';

const USAGE = 'usage: maka eval run <spec.json> --out <directory> [--cell <cell-id>]';

export interface EvalCliDependencies {
  readonly loadExecutor: (spec: ExperimentSpec, specPath: string) => ExperimentExecutor;
  readonly subjects: readonly SubjectAdapter[];
  readonly signal?: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export async function runMakaEvalCli(
  argv: readonly string[],
  overrides: Partial<EvalCliDependencies> = {},
): Promise<number> {
  const controller = overrides.signal ? undefined : new AbortController();
  const signal = overrides.signal ?? controller?.signal;
  let interrupted: number | undefined;
  const interrupt = () => {
    interrupted = 130;
    controller?.abort();
  };
  const terminate = () => {
    interrupted = 143;
    controller?.abort();
  };
  if (controller) {
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
  }
  try {
    const command = parseArgs(argv);
    if (command.kind === 'help') {
      (overrides.stdout ?? process.stdout.write.bind(process.stdout))(`${USAGE}\n`);
      return 0;
    }
    const specPath = resolve(command.specPath);
    const spec = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
    const directory = await openExperimentDirectory(resolve(command.outDir), spec);
    let executor: ExperimentExecutor;
    if (overrides.loadExecutor) {
      executor = overrides.loadExecutor(spec, specPath);
    } else {
      const builtin = builtinExecutor(spec, specPath);
      await builtin.preflight({
        subjectCredentialNames: [
          ...new Set(spec.subjects.flatMap((subject) => subject.credentials)),
        ],
        ...(signal ? { signal } : {}),
      });
      executor = builtin;
    }
    const results = await runExperiment({
      spec,
      store: directory.attempts,
      executor,
      subjects: overrides.subjects ?? [createMakaSubjectAdapter(), createExternalSubjectAdapter()],
      ...(command.cellIds.length > 0 ? { cellIds: command.cellIds } : {}),
      ...(signal ? { signal } : {}),
    });
    const incomplete = spec.tasks.length * spec.repetitions * spec.subjects.length - results.size;
    (overrides.stdout ?? process.stdout.write.bind(process.stdout))(
      `${JSON.stringify({ experimentId: spec.id, cells: results.size, incomplete })}\n`,
    );
    return interrupted ?? (incomplete === 0 ? 0 : 1);
  } catch (error) {
    (overrides.stderr ?? process.stderr.write.bind(process.stderr))(
      `maka eval: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
    );
    return interrupted ?? 2;
  } finally {
    if (controller) {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  }
}

function builtinExecutor(spec: ExperimentSpec, specPath: string): HarnessExecutor {
  if (spec.executor.kind === 'harbor') return createHarborExecutor(spec.executor.config, specPath);
  if (spec.executor.kind === 'pier') return createPierExecutor(spec.executor.config, specPath);
  throw new Error(`unsupported executor: ${spec.executor.kind}`);
}

function parseArgs(argv: readonly string[]):
  | { readonly kind: 'help' }
  | {
      readonly kind: 'run';
      readonly specPath: string;
      readonly outDir: string;
      readonly cellIds: readonly string[];
    } {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { kind: 'help' };
  if (argv[0] !== 'run' || !argv[1] || argv[1].startsWith('-')) throw new Error(USAGE);
  let outDir: string | undefined;
  const cellIds: string[] = [];
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--out') outDir = value;
    else if (flag === '--cell') cellIds.push(value);
    else throw new Error(`unexpected argument: ${flag}`);
  }
  if (!outDir) throw new Error('--out is required');
  return { kind: 'run', specPath: argv[1], outDir, cellIds };
}
