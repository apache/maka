import type { OperationSpecMap } from '@maka/runtime-host/protocol';

export const RENDERER_RUNTIME_HOST_QUERY_OPERATIONS = [
  // Read-only, session-scoped, and already the owner of "what is the context
  // made of" for `/context` (#1580, #2323). Admitted on the same terms as the
  // inspect query beside it: it reads a projection and writes nothing.
  'context.diagnostics.query',
  'daily-review.query',
  'execution.inspect.query',
  'scheduled-task.query',
] as const satisfies readonly (keyof OperationSpecMap)[];

export const RENDERER_RUNTIME_HOST_COMMAND_OPERATIONS = [
  'daily-review.mutate',
  'scheduled-task.mutate',
  'web-search.execute',
] as const satisfies readonly (keyof OperationSpecMap)[];

/** Runtime Host operations that the sandboxed renderer may invoke directly. */
export const RENDERER_RUNTIME_HOST_OPERATIONS = [
  ...RENDERER_RUNTIME_HOST_QUERY_OPERATIONS,
  ...RENDERER_RUNTIME_HOST_COMMAND_OPERATIONS,
] as const;

export type RendererRuntimeHostQueryOperation =
  (typeof RENDERER_RUNTIME_HOST_QUERY_OPERATIONS)[number];
export type RendererRuntimeHostCommandOperation =
  (typeof RENDERER_RUNTIME_HOST_COMMAND_OPERATIONS)[number];
export type RendererRuntimeHostOperation =
  | RendererRuntimeHostQueryOperation
  | RendererRuntimeHostCommandOperation;
