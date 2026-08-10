export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface ExperimentSpec {
  readonly schemaVersion: 'maka.eval.v1';
  readonly id: string;
  readonly benchmark: {
    readonly id: string;
    readonly version: string;
    readonly config: JsonObject;
  };
  readonly executor: { readonly kind: string; readonly config: JsonObject };
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
