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

// packages/runtime/src/preparation/tool-preparation-service.ts
// The process-level synthesis root. It is the ONLY place that fills in a
// `PreparedOperation` from a raw ToolCall:
//   ① schema validation, ② canonicalisation (tool name + cwd + frozen input),
//   ③ dispatch to a domain ResourceAuthority, ④ merge claims + compose execute.
//
// It never touches a real resource, and never decides ordering — those belong
// to the domain Authority and the Scheduler respectively.

import { realpath } from 'node:fs/promises';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import { oneShotOperation } from './one-shot-operation.js';
import { allResourceAuthority } from './placeholder-authorities.js';
import type { AuthorityContext, PreparedOperation } from './types.js';
import type { ToolAuthorityRegistry } from './tool-authority-registry.js';

export interface CanonicalCallContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly executionBoundary?: ExecutionBoundary;
  readonly permissionMode?: PermissionMode;
  readonly abortSignal?: AbortSignal;
}

export interface CanonicalToolCall<Input> {
  /** Cross-provider-normalised tool id; the key to resolveAuthority. */
  readonly toolId: string;
  /** Display name for tracing. */
  readonly toolName: string;
  /** Validated + deep-frozen + normalised input snapshot. */
  readonly input: Readonly<Input>;
  /** Canonical (realpath'd) cwd. */
  readonly cwd: string;
  readonly context: Readonly<CanonicalCallContext>;
}

interface SchemaValidator {
  parse(
    value: unknown,
  ): Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }
  >;
}

export class ToolPreparationService {
  constructor(private readonly authorities: ToolAuthorityRegistry) {}

  async prepare(toolCall: {
    readonly tool: MakaTool;
    readonly input: unknown;
    readonly ctx: MakaToolContext;
  }): Promise<PreparedOperation<unknown>> {
    // ① schema validation at the synthesis root, before any authority. A tool
    //    without a discoverable schema skips this step: executeTool's own arg
    //    validation remains the authoritative rejection.
    const schema = schemaFor(toolCall.tool);
    const validated = schema
      ? await schema.parse(toolCall.input)
      : { ok: true as const, value: toolCall.input };
    if (!validated.ok) return invalidOperation(toolCall.tool.name, validated.error);

    // ② canonicalise AFTER validation. The canonical form (not the raw provider
    //    shape) is what the authority and the Scheduler key on.
    const canonical = await canonicalizeToolCall({
      tool: toolCall.tool,
      input: validated.value,
      ctx: toolCall.ctx,
    });

    // ③ dispatch only through the process-owned registry. A real tool whose
    //    effect has not been classified fails closed to all modelled resources.
    //    Synthetic/no-effect calls bypass this fallback with noneOperation().
    const authority = this.authorities.resolve(canonical.toolId) ?? allResourceAuthority();
    const operation = await authority.prepare(
      canonical.input,
      this.toAuthorityContext(canonical, toolCall.ctx, toolCall.tool),
    );
    return oneShotOperation(this.compose([operation]));
  }

  private toAuthorityContext(
    canonical: CanonicalToolCall<unknown>,
    ctx: MakaToolContext,
    tool: MakaTool,
  ): AuthorityContext {
    return {
      sessionId: canonical.context.sessionId,
      ...(canonical.context.runId ? { runId: canonical.context.runId } : {}),
      turnId: canonical.context.turnId,
      cwd: canonical.cwd,
      ...(canonical.context.executionBoundary
        ? { executionBoundary: canonical.context.executionBoundary }
        : {}),
      ...(canonical.context.permissionMode
        ? { permissionMode: canonical.context.permissionMode }
        : {}),
      toolCallId: canonical.context.toolCallId,
      ...(canonical.context.abortSignal ? { abortSignal: canonical.context.abortSignal } : {}),
      // Placeholder authorities have no effect of their own; hand them the real
      // tool implementation so execution still routes through settleToolCall.
      effect: async (signal) => {
        const args = structuredClone(canonical.input) as never;
        return await tool.impl(args, { ...ctx, abortSignal: signal ?? ctx.abortSignal });
      },
    };
  }

  private compose<Result>(
    operations: readonly PreparedOperation<Result>[],
  ): PreparedOperation<Result> {
    if (operations.length === 0) {
      return { claims: [], execute: () => Promise.resolve() as Promise<Result> };
    }
    if (operations.length === 1) return operations[0]!;
    const claims = operations.flatMap((operation) => operation.claims);
    return {
      claims,
      execute: async (signal, fallbackEffect, executionContext) => {
        // Run each authority's effect in order; the first rejection stops the chain.
        for (const operation of operations) {
          await operation.execute(signal, fallbackEffect, executionContext);
        }
        return undefined as Result;
      },
    };
  }
}

/**
 * Canonicalise a validated call: canonical cwd (realpath, falling back to the
 * raw value), canonical tool id, and a deep-frozen input snapshot. The frozen
 * snapshot is what `execute` captures — mutating the caller's live object after
 * `prepare` must not affect the already-prepared operation.
 */
export async function canonicalizeToolCall<Input>(input: {
  readonly tool: MakaTool;
  readonly input: Input;
  readonly ctx: MakaToolContext;
}): Promise<CanonicalToolCall<Input>> {
  const taskCwd = input.ctx.cwd;
  const cwd = await realpath(taskCwd).catch(() => taskCwd);
  return {
    toolId: input.tool.name,
    toolName: input.tool.name,
    input: freezeDeep(structuredClone(input.input)),
    cwd,
    // The context is a shallow-frozen record of scalars plus live references
    // (abortSignal, executionBoundary). Deep-freezing would freeze the live
    // AbortSignal and break later abort() calls.
    context: Object.freeze({
      sessionId: input.ctx.sessionId,
      ...(input.ctx.runId ? { runId: input.ctx.runId } : {}),
      turnId: input.ctx.turnId,
      toolCallId: input.ctx.toolCallId,
      ...(input.ctx.executionBoundary ? { executionBoundary: input.ctx.executionBoundary } : {}),
      ...(input.ctx.permissionMode ? { permissionMode: input.ctx.permissionMode } : {}),
      ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
    }),
  };
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return Object.freeze(value as never);
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value) as Readonly<T>;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) freezeDeep(entry);
  return Object.freeze(value) as Readonly<T>;
}

function invalidOperation(toolName: string, detail: string): PreparedOperation<unknown> {
  const message = `Tool ${toolName} input could not be prepared: ${detail}`;
  return oneShotOperation({
    claims: [],
    execute: () => Promise.reject(new Error(message)),
  });
}

function schemaFor(tool: MakaTool): SchemaValidator | undefined {
  const parameters = tool.parameters as {
    safeParse?: (value: unknown) => unknown;
    validate?: (value: unknown) => unknown;
  } | null;
  if (!parameters) return undefined;
  if (typeof parameters.safeParse === 'function') {
    return {
      async parse(value) {
        const result = (await parameters.safeParse!(value)) as {
          success: boolean;
          data?: unknown;
          error?: unknown;
        };
        return result.success
          ? { ok: true, value: result.data }
          : { ok: false, error: String(result.error) };
      },
    };
  }
  if (typeof parameters.validate === 'function') {
    return {
      async parse(value) {
        const result = (await parameters.validate!(value)) as {
          success?: boolean;
          value?: unknown;
          error?: unknown;
        };
        if (result.success === true) return { ok: true, value: result.value };
        return { ok: false, error: String(result.error) };
      },
    };
  }
  return undefined;
}
