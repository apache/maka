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

/**
 * The call-data boundary for one tool execution: the argument views a call
 * produces and the common fields its `tool_start` event and persisted
 * `tool_call` message share.
 *
 * Extracted from `executeTool()` so the ownership of each rule is named
 * instead of living inline in a thousand-line method. This module owns
 * *construction only* — admission, dispatch identity, publication timing and
 * persistence stay in `executeTool()`.
 */

import { computerUseModelCallArgs } from '@maka/core/computer-use';
import type { ToolActivityKind } from '@maka/core/events';

/** The recursively frozen, cycle-rejecting argument snapshot. */
export function snapshotToolArgs(value: unknown): unknown {
  return snapshotJsonValue(value, new WeakSet<object>());
}

function snapshotJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Tool arguments must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => snapshotJsonValue(entry, seen)));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`Tool argument ${key} must be a plain data property`);
    }
    output[key] = snapshotJsonValue(descriptor.value, seen);
  }
  return Object.freeze(output);
}

/**
 * Validates call arguments against the tool's declared schema, accepting the
 * schema shapes the runtime already supports (zod `safeParseAsync`/`safeParse`,
 * a `validate` callable, or a standard-schema `~standard.validate`). A tool
 * without a usable schema declares nothing and validates nothing.
 */
export async function validateDeclaredToolArgs(parameters: unknown, args: unknown): Promise<void> {
  if (!parameters || (typeof parameters !== 'object' && typeof parameters !== 'function')) {
    return;
  }
  const schema = parameters as {
    safeParseAsync?: (
      value: unknown,
    ) => PromiseLike<{ success: true; data: unknown } | { success: false; error: unknown }>;
    safeParse?: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false; error: unknown };
    validate?: (
      value: unknown,
    ) =>
      | { success: true; value: unknown }
      | { success: false; error: unknown }
      | PromiseLike<{ success: true; value: unknown } | { success: false; error: unknown }>;
    '~standard'?: {
      validate?: (
        value: unknown,
      ) =>
        | { value: unknown }
        | { issues: readonly unknown[] }
        | PromiseLike<{ value: unknown } | { issues: readonly unknown[] }>;
    };
  };

  if (typeof schema.safeParseAsync === 'function') {
    const parsed = await schema.safeParseAsync(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema.validate === 'function') {
    const parsed = await schema.validate(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema['~standard']?.validate === 'function') {
    const parsed = await schema['~standard'].validate(args);
    if ('value' in parsed) return;
    throw new Error('Tool arguments failed declared schema validation', { cause: parsed.issues });
  }
}

/** Permission-projection context handed to a tool's `permissionArgs` hook. */
export interface ToolPermissionArgsContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

/** Input to {@link buildToolCallArgs}. */
export interface ToolCallArgsInput {
  toolName: string;
  /** Declared argument schema; validation runs against the execution snapshot. */
  parameters: unknown;
  /** Category hint, selecting the Computer Use persisted/model projection. */
  categoryHint?: string | undefined;
  /**
   * The tool's permission-oriented projection. When present, it receives a
   * private mutable clone of the execution args and its result is
   * re-snapshotted — exactly as the inline region did.
   */
  permissionArgs?: ((args: never, context: ToolPermissionArgsContext) => unknown) | undefined;
  /** The canonical execution input, snapshotted synchronously at entry. */
  executionArgs: unknown;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /**
   * Direct-only nested rejection skips validation and permission projection
   * entirely — the call never reaches the tool.
   */
  directOnlyRejected: boolean;
  /**
   * An unavailable sandbox-boundary surface retains its current validation
   * exception, so validation is deferred while every other rule still applies.
   */
  validationDeferred: boolean;
}

/**
 * The four argument views of one tool call. Each has one owner and one job:
 *
 *  - `executionArgs` — canonical execution input. Consumers receive private
 *    mutable clones; the view itself stays frozen.
 *  - `permissionArgs` — the tool's permission-oriented projection, also read
 *    by downstream policy/signature logic.
 *  - `persistedArgs` — what the `tool_start` event, the persisted `tool_call`
 *    message and the durable call data record.
 *  - `modelFacingArgs` — what the model reads back as its own call.
 */
export interface ToolCallArgs {
  readonly executionArgs: unknown;
  readonly permissionArgs: unknown;
  readonly persistedArgs: unknown;
  readonly modelFacingArgs: unknown;
}

export interface ToolCallArgsAndProjectionError extends ToolCallArgs {
  /**
   * First validation or permission-projection failure. The caller routes it
   * to the existing refusal path; the builder never throws for it.
   */
  readonly permissionArgsError: unknown;
}

/**
 * The named argument-view construction operation: validation, permission
 * projection, and the persisted/model-facing views, in the order and with the
 * guards the inline region in `executeTool()` established.
 *
 * The args written into the `tool_start` event, the persisted `tool_call`
 * message and the durable ledger are the record of the call the model reads
 * back on its next turn (`model-history.ts` replays `event.content.args`).
 *
 * Computer Use used the host's approval summary there. That projection exists
 * to decide and display a permission: it renames `window_id` to `windowId`,
 * adds `approvalClass` and `rememberForTurnAllowed`, and drops every argument
 * it does not need. On the real ToolRuntime a model that sent
 * {action:'press_key', app, window_id, observation_id, element_id,
 * text:'cmd+s'} read back {action, approvalClass, rememberForTurnAllowed,
 * app, windowId, observationId} — a key the tool rejects, two fields it never
 * sent, no element, and a press_key with no key. It then went on calling it
 * that way.
 *
 * The permission prompt still reads the permission view, and the approval
 * scope key is still computed from the raw call, so the projection only
 * changes what is written down. `computerUseModelCallArgs` keeps the same
 * privacy rule — screen-derived and user-typed values are reduced to a shape
 * — and speaks the tool's own argument names.
 *
 * The model-facing view is the same projection as the audit record, since
 * `computerUseModelCallArgs` became what both are written with. It was
 * spelled out twice, which meant running it twice per call and leaving two
 * expressions to drift apart. The two names stay because the roles are
 * different — one is what the host records, one is what the model reads — and
 * a divergence would go here.
 */
export async function buildToolCallArgs(
  input: ToolCallArgsInput,
): Promise<ToolCallArgsAndProjectionError> {
  let permissionArgs = input.executionArgs;
  let permissionArgsError: unknown;
  if (!input.directOnlyRejected) {
    try {
      if (!input.validationDeferred) {
        await validateDeclaredToolArgs(input.parameters, input.executionArgs);
      }
      permissionArgs = input.permissionArgs
        ? snapshotToolArgs(
            input.permissionArgs(structuredClone(input.executionArgs) as never, {
              sessionId: input.sessionId,
              turnId: input.turnId,
              toolCallId: input.toolCallId,
            }),
          )
        : input.executionArgs;
    } catch (error) {
      permissionArgsError = error;
    }
  }
  const persistedArgs =
    input.categoryHint === 'computer_use'
      ? snapshotToolArgs(computerUseModelCallArgs(permissionArgs))
      : permissionArgs;
  return {
    executionArgs: input.executionArgs,
    permissionArgs,
    permissionArgsError,
    persistedArgs,
    modelFacingArgs: persistedArgs,
  };
}

/**
 * Identity facts every tool activity record carries. Mirrors the private
 * `ToolActivityIdentity` in `@maka/core/events`, which is not exported.
 */
export interface ToolActivityIdentityFields {
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
}

/** Input to {@link buildToolCallCommonFields}. */
export interface ToolCallCommonFieldsInput extends ToolActivityIdentityFields {
  turnId: string;
  ts: number;
  toolUseId: string;
  toolName: string;
  activityKind?: ToolActivityKind | undefined;
  displayName?: string | undefined;
  persistedArgs: unknown;
  providerOptions?: Record<string, unknown> | undefined;
  stepId?: string | undefined;
}

/** The fields both call records share, with privately owned copies. */
export interface ToolCallCommonFields extends ToolActivityIdentityFields {
  turnId: string;
  ts: number;
  toolUseId: string;
  toolName: string;
  activityKind?: ToolActivityKind | undefined;
  displayName?: string | undefined;
  args: unknown;
  providerOptions?: Record<string, unknown> | undefined;
  stepId?: string | undefined;
}

/**
 * The one recipe for the fields both call records share, replacing the two
 * handwritten ones in `executeTool()`. Each invocation allocates its own
 * `args` and `providerOptions` clones — the event and the message are
 * independently owned outputs, and sharing one mutable args object across
 * them would break the isolation the duplicated recipes guaranteed.
 */
export function buildToolCallCommonFields(input: ToolCallCommonFieldsInput): ToolCallCommonFields {
  return {
    turnId: input.turnId,
    ts: input.ts,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.modelVisibility !== undefined ? { modelVisibility: input.modelVisibility } : {}),
    ...(input.parentToolCallId !== undefined ? { parentToolCallId: input.parentToolCallId } : {}),
    ...(input.parentOperationId !== undefined
      ? { parentOperationId: input.parentOperationId }
      : {}),
    ...(input.activityKind !== undefined ? { activityKind: input.activityKind } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    args: structuredClone(input.persistedArgs),
    ...(input.providerOptions !== undefined
      ? { providerOptions: structuredClone(input.providerOptions) }
      : {}),
    ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
  };
}
