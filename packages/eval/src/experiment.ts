export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export function decodeJsonObject(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, decodeJsonValue(child, `${where}.${key}`)]),
  );
}

function decodeJsonValue(value: unknown, where: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((child, index) => decodeJsonValue(child, `${where}[${index}]`));
  }
  if (value && typeof value === 'object') return decodeJsonObject(value, where);
  throw new Error(`${where} must be JSON`);
}

export interface ExperimentSpec {
  readonly schemaVersion: 'maka.eval.v1';
  readonly id: string;
  readonly benchmark: {
    readonly id: string;
    readonly version: string;
    readonly config: JsonObject;
  };
  readonly executor: { readonly kind: string; readonly config: JsonObject };
  readonly execution: { readonly maxConcurrentTaskGroups: number };
  readonly subjects: readonly {
    readonly id: string;
    readonly kind: 'maka' | 'external';
    readonly credentials: readonly string[];
    readonly config: JsonObject;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly input: string;
    readonly config: JsonObject;
  }[];
  readonly repetitions: number;
  readonly budget: JsonObject;
  readonly verifier: JsonObject;
}

export interface ExperimentCell {
  readonly id: string;
  readonly experimentId: string;
  readonly benchmark: ExperimentSpec['benchmark'];
  readonly executor: ExperimentSpec['executor'];
  readonly subject: ExperimentSpec['subjects'][number];
  readonly task: ExperimentSpec['tasks'][number];
  readonly repetition: number;
  readonly budget: JsonObject;
  readonly verifier: JsonObject;
}

export function expandExperiment(spec: ExperimentSpec): ExperimentCell[] {
  return spec.tasks.flatMap((task) =>
    Array.from({ length: spec.repetitions }, (_, repetition) => repetition + 1).flatMap(
      (repetition) =>
        spec.subjects.map((subject) => ({
          id: `${task.id}::${repetition}::${subject.id}`,
          experimentId: spec.id,
          benchmark: spec.benchmark,
          executor: spec.executor,
          subject,
          task,
          repetition,
          budget: spec.budget,
          verifier: spec.verifier,
        })),
    ),
  );
}
