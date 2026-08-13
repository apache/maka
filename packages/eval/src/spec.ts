import { decodeJsonObject, type ExperimentSpec } from './experiment.js';

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  const root = exact(
    value,
    'experiment',
    [
      'schemaVersion',
      'id',
      'benchmark',
      'executor',
      'subjects',
      'tasks',
      'repetitions',
      'budget',
      'verifier',
    ],
    ['execution'],
  );
  if (root.schemaVersion !== 'maka.eval.v1') throw new Error('unsupported experiment schema');
  const benchmark = exact(root.benchmark, 'benchmark', ['id', 'version', 'config']);
  const executor = exact(root.executor, 'executor', ['kind', 'config']);
  const execution =
    root.execution === undefined
      ? { maxConcurrentTaskGroups: 1 }
      : exact(root.execution, 'execution', ['maxConcurrentTaskGroups']);
  const subjects: ExperimentSpec['subjects'][number][] = array(root.subjects, 'subjects').map(
    (value, index) => {
      const subject = exact(value, `subjects[${index}]`, ['id', 'kind', 'credentials', 'config']);
      if (subject.kind !== 'maka' && subject.kind !== 'external') {
        throw new Error(`subjects[${index}].kind is invalid`);
      }
      return {
        id: identifier(subject.id, `subjects[${index}].id`),
        kind: subject.kind === 'maka' ? 'maka' : 'external',
        credentials: uniqueStrings(subject.credentials, `subjects[${index}].credentials`),
        config: decodeJsonObject(subject.config, `subjects[${index}].config`),
      };
    },
  );
  const tasks = array(root.tasks, 'tasks').map((value, index) => {
    const task = exact(value, `tasks[${index}]`, ['id', 'input', 'config']);
    return {
      id: identifier(task.id, `tasks[${index}].id`),
      input: nonempty(task.input, `tasks[${index}].input`),
      config: decodeJsonObject(task.config, `tasks[${index}].config`),
    };
  });
  if (subjects.length === 0 || tasks.length === 0) throw new Error('experiment arms are empty');
  uniqueIds(subjects, 'subject');
  uniqueIds(tasks, 'task');
  return deepFreeze({
    schemaVersion: 'maka.eval.v1',
    id: identifier(root.id, 'experiment.id'),
    benchmark: {
      id: identifier(benchmark.id, 'benchmark.id'),
      version: nonempty(benchmark.version, 'benchmark.version'),
      config: decodeJsonObject(benchmark.config, 'benchmark.config'),
    },
    executor: {
      kind: identifier(executor.kind, 'executor.kind'),
      config: decodeJsonObject(executor.config, 'executor.config'),
    },
    execution: {
      maxConcurrentTaskGroups: positiveInteger(
        execution.maxConcurrentTaskGroups,
        'execution.maxConcurrentTaskGroups',
      ),
    },
    subjects,
    tasks,
    repetitions: positiveInteger(root.repetitions, 'repetitions'),
    budget: decodeJsonObject(root.budget, 'budget'),
    verifier: decodeJsonObject(root.verifier, 'verifier'),
  });
}

function exact(
  value: unknown,
  where: string,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key) && !optional.includes(key)))
    throw new Error(`${where} has unsupported fields`);
  for (const field of fields)
    if (!Object.hasOwn(record, field)) throw new Error(`${where}.${field} is required`);
  return record;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function identifier(value: unknown, where: string): string {
  const text = nonempty(value, where);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(text)) throw new Error(`${where} is invalid`);
  return text;
}

function nonempty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
  return value;
}

function uniqueStrings(value: unknown, where: string): string[] {
  const values = array(value, where).map((item) => nonempty(item, where));
  if (new Set(values).size !== values.length) throw new Error(`${where} contains duplicates`);
  return values;
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${where} must be positive`);
  return value as number;
}

function uniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = values.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${label} id`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
