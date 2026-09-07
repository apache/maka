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
 * The argument-data boundary for one tool call.
 *
 * This module owns construction only. Admission, dispatch identity,
 * transcript publication, durability and execution remain in ToolRuntime.
 */

import { computerUseModelCallArgs } from '@maka/core/computer-use';

/** Recursively freezes a tool argument snapshot and rejects non-data values. */
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
 * Validates the schema shapes supported by the runtime without changing the
 * existing validation order or error behavior.
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

export interface ToolPermissionArgsContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

export interface ToolCallArgsInput {
  parameters: unknown;
  categoryHint?: string | undefined;
  permissionArgs?: ((args: never, context: ToolPermissionArgsContext) => unknown) | undefined;
  executionArgs: unknown;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** Skip validation and permission projection for direct-only nested calls. */
  directOnlyRejected: boolean;
  /** Preserve the unavailable sandbox-boundary validation exception. */
  validationDeferred: boolean;
}

export interface ToolCallArgs {
  readonly executionArgs: unknown;
  readonly permissionArgs: unknown;
  readonly persistedArgs: unknown;
  readonly modelFacingArgs: unknown;
  readonly permissionArgsError: unknown;
}

/**
 * Builds the four existing argument views in the same order as executeTool.
 * The caller still owns admission decisions; the booleans only preserve which
 * existing preparation steps are allowed for this call.
 */
export async function buildToolCallArgs(input: ToolCallArgsInput): Promise<ToolCallArgs> {
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
    persistedArgs,
    modelFacingArgs: persistedArgs,
    permissionArgsError,
  };
}
