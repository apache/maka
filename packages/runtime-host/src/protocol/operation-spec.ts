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
  | 'invalid_request'
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
}

type AnyOperationSpec = OperationSpec<unknown, unknown, HostOperationErrorCode>;
export type OperationSpecMap = Readonly<Record<string, AnyOperationSpec>>;
type DuplicateOperationKeys<Left, Right> = Extract<keyof Left, keyof Right>;
type RequireDisjointOperationKeys<Left, Right> = [DuplicateOperationKeys<Left, Right>] extends [
  never,
]
  ? unknown
  : { readonly duplicateOperationKeys: DuplicateOperationKeys<Left, Right> };

export function defineOperation<Input, Output, ErrorCode extends HostOperationErrorCode>(
  spec: OperationSpec<Input, Output, ErrorCode>,
): OperationSpec<Input, Output, ErrorCode> {
  if (!(spec.errors as readonly HostOperationErrorCode[]).includes('internal_failure')) {
    throw new Error('Every Runtime Host operation must declare internal_failure');
  }
  return spec;
}

export function composeOperationSpecMaps<
  const Left extends OperationSpecMap,
  const Right extends OperationSpecMap,
>(left: Left, right: Right & RequireDisjointOperationKeys<Left, Right>): Left & Right {
  const combined: Record<string, AnyOperationSpec> = { ...left };
  for (const [key, spec] of Object.entries(right)) {
    if (Object.hasOwn(combined, key)) {
      throw new Error(`Duplicate Runtime Host operation key: ${key}`);
    }
    combined[key] = spec;
  }
  return combined as Left & Right;
}
