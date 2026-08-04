export type OperationMode = 'command' | 'query' | 'control';
export type OperationAvailability = 'bootstrap' | 'ready';

export type HostOperationErrorCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'capability_unavailable'
  | 'invalid_request'
  | 'projection_incomplete'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'already_resolved'
  | 'outcome_unknown'
  | 'internal_failure';

export interface HostOperationError<C extends HostOperationErrorCode = HostOperationErrorCode> {
  code: C;
  message: string;
}

export interface OperationSpec<Input, Output, ErrorCode extends HostOperationErrorCode> {
  mode: OperationMode;
  availability: OperationAvailability;
  errors: readonly ErrorCode[];
  decodeInput(value: unknown): Input;
  decodeOutput(value: unknown): Output;
  assertOutputForInput?(input: Input, output: Output): void;
}

type AnyOperationSpec = OperationSpec<unknown, unknown, HostOperationErrorCode>;
export type OperationSpecMap = Readonly<Record<string, AnyOperationSpec>>;
type OperationSpecMaps = readonly [OperationSpecMap, ...OperationSpecMap[]];
type OperationSpecMapIntersection<Maps extends OperationSpecMaps> = UnionToIntersection<
  Maps[number]
>;
type DuplicateOperationKeys<
  Maps extends readonly OperationSpecMap[],
  Seen = never,
> = Maps extends readonly [
  infer Head extends OperationSpecMap,
  ...infer Tail extends OperationSpecMap[],
]
  ? Extract<keyof Head, Seen> | DuplicateOperationKeys<Tail, Seen | keyof Head>
  : never;
type RequireDisjointOperationKeys<Maps extends OperationSpecMaps> = [
  DuplicateOperationKeys<Maps>,
] extends [never]
  ? unknown
  : { readonly duplicateOperationKeys: DuplicateOperationKeys<Maps> };
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

export function defineOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: OperationSpec<Input, Output, ErrorCode>,
): OperationSpec<Input, Output, ErrorCode> {
  if (!(spec.errors as readonly HostOperationErrorCode[]).includes('internal_failure')) {
    throw new Error('Every Runtime Host operation must declare internal_failure');
  }
  return spec;
}

export function composeOperationSpecMaps<const Maps extends OperationSpecMaps>(
  ...maps: Maps & RequireDisjointOperationKeys<Maps>
): OperationSpecMapIntersection<Maps> {
  const combined: Record<string, AnyOperationSpec> = {};
  for (const map of maps) {
    for (const [key, spec] of Object.entries(map)) {
      if (Object.hasOwn(combined, key)) {
        throw new Error(`Duplicate Runtime Host operation key: ${key}`);
      }
      combined[key] = spec;
    }
  }
  return combined as OperationSpecMapIntersection<Maps>;
}
