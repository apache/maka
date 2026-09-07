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

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  PREPARED_REQUEST_OBSERVATION_TEXT_MAX_LENGTH,
  type PromptComposition,
} from '@maka/core/model-call-attempt';
import { foldPromptComposition, type SizedRequestSegment } from './prompt-composition.js';
import { toJSONSchema } from 'zod';

import type { MakaTool } from './tool-runtime.js';

export interface CanonicalToolSet {
  providerTools: MakaTool[];
  activeTools: string[];
}

/**
 * Split the registry into the full dispatch set (`providerTools`) and the
 * model-visible subset (`activeTools`).
 *
 * `activeNames` is the explicit allow-list of tools to advertise this step —
 * the single source of truth computed by `ToolAvailabilityRuntime` (core +
 * ungrouped + loaded groups). A tool absent from it is withheld from
 * `activeTools` but stays in `providerTools` so it remains dispatchable once
 * its group loads. Omitting `activeNames` advertises every visible tool — the
 * full-surface case (search availability omitted).
 */
export function canonicalizeToolSet(
  tools: readonly MakaTool[],
  invalidTool: MakaTool,
  activeNames?: ReadonlySet<string>,
): CanonicalToolSet {
  const visibleTools = tools
    .filter((tool) => tool.name !== invalidTool.name)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  // providerTools stays the full registry (dispatch never depends on visibility).
  // activeTools is the model-visible subset the AI SDK serializes to the
  // provider, so a gated-and-unloaded schema stays off the wire.
  const activeTools = visibleTools
    .filter((tool) => activeNames === undefined || activeNames.has(tool.name))
    .map((tool) => tool.name);
  return {
    providerTools: [...visibleTools, invalidTool],
    activeTools,
  };
}

export function toolSchemaCharsForDiagnostics(
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
): number {
  return stableStringify({
    activeTools: [...activeTools],
    providerTools: providerVisibleTools(providerTools, activeTools).map(toolShapeForDiagnostics),
  }).length;
}

/**
 * Observe the standardized request at the AI SDK model-call seam.
 *
 * Segment order follows Maka's semantic request-prefix model: tools, system
 * instructions, then conversation messages. Provider options are retained for
 * exact request evidence, but are not claimed to be a provider-cacheable prefix
 * segment. None of this is presented as the provider's final wire body.
 */
export function preparedPromptComposition(payload: unknown): PromptComposition | undefined {
  const segments: SizedRequestSegment[] = [];
  const parts = semanticRequestParts(payload);

  for (const tool of parts.tools) segments.push(sizedSegment('tool_schema', tool, toolLabel(tool)));
  if (parts.instructions !== undefined) {
    const instructions = Array.isArray(parts.instructions)
      ? parts.instructions
      : [parts.instructions];
    for (const instruction of instructions)
      segments.push(sizedSegment('system_prompt', instruction));
  }
  for (const message of parts.messages) segments.push(sizedSegment('message', message));
  if (parts.providerOptions !== undefined) {
    segments.push(sizedSegment('provider_options', parts.providerOptions));
  }

  // Folded here rather than stored part by part. The fold is bounded by its own
  // output — four kinds and a capped tool list — so the unbounded segment list
  // never leaves this function and needs no cap of its own.
  return foldPromptComposition(segments);
}

function sizedSegment(
  kind: SizedRequestSegment['kind'],
  value: unknown,
  label?: string,
): SizedRequestSegment {
  const serialized = JSON.stringify(normalizePreparedValue(value));
  return {
    kind,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    ...(label !== undefined
      ? { label: label.slice(0, PREPARED_REQUEST_OBSERVATION_TEXT_MAX_LENGTH) }
      : {}),
  };
}

function semanticRequestParts(payload: unknown): {
  instructions?: unknown;
  messages: readonly unknown[];
  tools: readonly unknown[];
  providerOptions?: Record<string, unknown>;
} {
  if (!isObjectLike(payload)) {
    return { messages: [], tools: [] };
  }
  const prompt = Array.isArray(payload.prompt) ? payload.prompt : undefined;
  const instructions: unknown[] = [];
  const messages: unknown[] = [];
  if (prompt) {
    for (const item of prompt) {
      const record = isObjectLike(item) ? item : undefined;
      if (record?.role === 'system') instructions.push(record.content);
      else messages.push(item);
    }
  }
  const payloadMessages = Array.isArray(payload.messages) ? payload.messages : undefined;
  const providerOptions = isPlainObject(payload.providerOptions)
    ? payload.providerOptions
    : undefined;
  return {
    ...(prompt
      ? instructions.length > 0
        ? { instructions }
        : {}
      : payload.instructions !== undefined
        ? { instructions: payload.instructions }
        : {}),
    messages: prompt ? messages : (payloadMessages ?? []),
    tools: Array.isArray(payload.tools) ? payload.tools : [],
    ...(providerOptions !== undefined ? { providerOptions } : {}),
  };
}

/** The provider-visible tools — the active subset actually serialized on the wire. */
function providerVisibleTools(
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
): MakaTool[] {
  const active = new Set(activeTools);
  return providerTools.filter((tool) => active.has(tool.name));
}

/**
 * The tool's own name as the payload carries it.
 *
 * Read off the prepared payload rather than the registry: this observation
 * describes what Maka handed to the model-call seam, so a name absent there is
 * not a name this segment can claim.
 */
function toolLabel(tool: unknown): string | undefined {
  if (!isObjectLike(tool)) return undefined;
  return typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined;
}

export function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function toolCatalogHash(tools: readonly MakaTool[]): `sha256:${string}` {
  return stableHash(
    [...tools]
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map(toolShapeForDiagnostics),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Lossless JSON representation for the semantic values accepted by the model
 * seam. Every value is tagged, so a bigint cannot collide with a user string
 * and an undefined property cannot disappear, and values that cannot be
 * described exactly are kept as explicit markers rather than dropped — a size
 * taken from this covers the whole payload.
 */
function normalizePreparedValue(value: unknown): unknown {
  const tag = '__makaPreparedValue';
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (Number.isFinite(current) && !Object.is(current, -0)) return current;
      const encoded = Number.isNaN(current)
        ? 'NaN'
        : current === Infinity
          ? 'Infinity'
          : current === -Infinity
            ? '-Infinity'
            : '-0';
      return { [tag]: 'number', value: encoded };
    }
    if (typeof current === 'bigint') return { [tag]: 'bigint', value: current.toString() };
    if (typeof current === 'undefined') return { [tag]: 'undefined' };
    if (typeof current !== 'object') return { [tag]: 'opaque', kind: typeof current };
    if (depth >= 64) return { [tag]: 'opaque', kind: 'max-depth' };
    if (ancestors.has(current)) return { [tag]: 'opaque', kind: 'cycle' };
    ancestors.add(current);
    try {
      if (current instanceof ArrayBuffer) {
        return {
          [tag]: 'binary',
          kind: 'ArrayBuffer',
          encoding: 'base64',
          value: Buffer.from(current).toString('base64'),
        };
      }
      if (ArrayBuffer.isView(current)) {
        return {
          [tag]: 'binary',
          kind: current.constructor?.name ?? 'ArrayBufferView',
          encoding: 'base64',
          value: Buffer.from(current.buffer, current.byteOffset, current.byteLength).toString(
            'base64',
          ),
        };
      }
      if (current instanceof Date) {
        const timestamp = current.getTime();
        return {
          [tag]: 'date',
          value: Number.isNaN(timestamp) ? 'invalid' : current.toISOString(),
        };
      }
      if (current instanceof Map) {
        const entries = [...current.entries()].map(([key, entry]) => [
          visit(key, depth + 1),
          visit(entry, depth + 1),
        ]);
        return { [tag]: 'map', entries };
      }
      if (current instanceof Set) {
        return { [tag]: 'set', entries: [...current].map((entry) => visit(entry, depth + 1)) };
      }
      if (Array.isArray(current)) {
        return Array.from({ length: current.length }, (_, index) =>
          index in current ? visit(current[index], depth + 1) : { [tag]: 'array-hole' },
        );
      }
      if (isPlainObject(current)) {
        const entries = Object.keys(current).map((key) => {
          try {
            return [key, visit(current[key], depth + 1)];
          } catch {
            return [key, { [tag]: 'opaque', kind: 'unreadable-property' }];
          }
        });
        if (Object.hasOwn(current, tag)) return { [tag]: 'object', entries };
        return Object.fromEntries(entries);
      }
      const toJSON = (current as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        try {
          return visit(toJSON.call(current), depth + 1);
        } catch {
          return { [tag]: 'opaque', kind: 'toJSON-failed' };
        }
      }
      return { [tag]: 'opaque', kind: current.constructor?.name ?? 'non-plain-object' };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

function toolShapeForDiagnostics(tool: MakaTool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schemaShapeForHash(tool.parameters),
    ...(tool.providerTool ? { providerTool: tool.providerTool } : {}),
  };
}

function schemaShapeForHash(schema: unknown): unknown {
  if (isObjectLike(schema)) {
    try {
      return stripJsonSchemaRuntimeFields(
        toJSONSchema(schema as never, {
          io: 'input',
          target: 'draft-07',
          unrepresentable: 'any',
          cycles: 'ref',
          reused: 'inline',
        }),
      );
    } catch {
      // Fall through to structural canonicalization for plain JSON-schema-like objects.
    }
  }
  return schema;
}

function stripJsonSchemaRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaRuntimeFields);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '~standard' || key === '$schema') continue;
    out[key] = stripJsonSchemaRuntimeFields(entry);
  }
  return out;
}

function canonicalize(value: unknown, parentKey?: string): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return shouldSortArray(parentKey)
      ? items.slice().sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
      : items;
  }
  if (value instanceof Date) return value.toISOString();
  if (!isObjectLike(value)) return String(value);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key], key);
  }
  return out;
}

function shouldSortArray(parentKey: string | undefined): boolean {
  return parentKey === 'required' || parentKey === 'enum';
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
