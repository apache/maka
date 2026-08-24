/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
