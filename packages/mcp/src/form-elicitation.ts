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

import {
  decodeInteractionAnswer,
  decodeInteractionRequest,
  interactionFormAnswerMatchesRequest,
  type InteractionFormInput,
  type InteractionFormResult,
  projectInteractionFormRequest,
} from '@maka/core/interaction';
import type { ElicitResult } from '@modelcontextprotocol/client';

// Unbounded protocol strings need a visible client input limit: Core reserves
// the worst-case JSON-escaped answer within its serialized interaction budget.
// Explicit server bounds are preserved and still checked by Core admission.
const DEFAULT_STRING_MAX_LENGTH = 256;

/** Inspect raw keys and values before projection can escape control characters.
 * This is a containment check, not a comparison with redacted output: a state
 * may itself be identical to the redaction marker.
 */
export function containsMcpFormState(value: unknown, states: readonly string[]): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (states.some((state) => state.length > 0 && item.includes(state))) return true;
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child);
    }
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
}

function select(value: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]),
  );
}

function options(value: unknown, titles?: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    (titles !== undefined && (!Array.isArray(titles) || titles.length !== value.length))
  )
    throw new Error();
  return value.map((entry, index) => ({
    value: entry,
    label: Array.isArray(titles) ? titles[index] : entry,
  }));
}

function titledOptions(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error();
  return value.map((entry) => {
    const option = record(entry);
    keys(option, ['const', 'title']);
    return { value: option.const, label: option.title };
  });
}

function field(name: string, value: unknown, required: boolean): Record<string, unknown> {
  const schema = record(value);
  const sharedKeys = ['type', 'title', 'description', 'default'];
  const shared = {
    name,
    label: Object.hasOwn(schema, 'title') ? schema.title : name,
    required,
    ...select(schema, ['description', 'default']),
  };
  if (schema.type === 'string') {
    if (Object.hasOwn(schema, 'enum')) {
      keys(schema, [...sharedKeys, 'enum', 'enumNames']);
      return { ...shared, kind: 'single_select', options: options(schema.enum, schema.enumNames) };
    }
    if (Object.hasOwn(schema, 'oneOf')) {
      keys(schema, [...sharedKeys, 'oneOf']);
      return { ...shared, kind: 'single_select', options: titledOptions(schema.oneOf) };
    }
    keys(schema, [...sharedKeys, 'minLength', 'maxLength', 'format']);
    return {
      ...shared,
      kind: 'string',
      ...select(schema, ['minLength', 'maxLength', 'format']),
      ...(schema.maxLength === undefined ? { maxLength: DEFAULT_STRING_MAX_LENGTH } : {}),
    };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    keys(schema, [...sharedKeys, 'minimum', 'maximum']);
    // Core validates numeric ranges; an integer-only interval may additionally be empty.
    if (
      schema.type === 'integer' &&
      typeof schema.minimum === 'number' &&
      typeof schema.maximum === 'number' &&
      Math.ceil(schema.minimum) > Math.floor(schema.maximum)
    )
      throw new Error();
    return { ...shared, kind: schema.type, ...select(schema, ['minimum', 'maximum']) };
  }
  if (schema.type === 'boolean') {
    keys(schema, sharedKeys);
    return { ...shared, kind: 'boolean' };
  }
  if (schema.type === 'array') {
    keys(schema, [...sharedKeys, 'items', 'minItems', 'maxItems']);
    const items = record(schema.items);
    let choices: unknown[];
    if (Object.hasOwn(items, 'anyOf')) {
      keys(items, ['anyOf']);
      choices = titledOptions(items.anyOf);
    } else {
      keys(items, ['type', 'enum']);
      if (items.type !== 'string') throw new Error();
      choices = options(items.enum);
    }
    return {
      ...shared,
      kind: 'multi_select',
      options: choices,
      ...select(schema, ['minItems', 'maxItems']),
    };
  }
  throw new Error();
}

/** Adapt one embedded MCP form request without exposing protocol state to the UI. */
export function prepareMcpForm(
  request: unknown,
  requester: { name: string; source?: string },
): { form: InteractionFormInput; respond(result: InteractionFormResult): ElicitResult } {
  try {
    const embedded = record(request);
    keys(embedded, ['method', 'params']);
    if (embedded.method !== 'elicitation/create') throw new Error();
    const params = record(embedded.params);
    keys(params, ['mode', 'message', 'requestedSchema', '_meta']);
    if (params.mode !== undefined && params.mode !== 'form') throw new Error();
    const schema = record(params.requestedSchema);
    keys(schema, [
      'type',
      'properties',
      'required',
      '$schema',
      'title',
      'description',
      'additionalProperties',
    ]);
    if (
      schema.type !== 'object' ||
      (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    )
      throw new Error();
    for (const annotation of ['$schema', 'title', 'description']) {
      if (schema[annotation] !== undefined && typeof schema[annotation] !== 'string')
        throw new Error();
    }
    const properties = record(schema.properties);
    const required: unknown = schema.required === undefined ? [] : schema.required;
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties, name)) ||
      new Set(required).size !== required.length
    )
      throw new Error();
    const decoded = decodeInteractionRequest({
      kind: 'form',
      toolUseId: 'mcp-form',
      message: params.message,
      requester,
      fields: Object.entries(properties).map(([name, schema]) =>
        field(name, schema, required.includes(name)),
      ),
    });
    if (decoded.kind !== 'form') throw new Error();
    const projected = projectInteractionFormRequest(decoded);
    return {
      form: {
        message: projected.message,
        requester: projected.requester,
        fields: projected.fields,
      },
      respond(result) {
        try {
          const answer = decodeInteractionAnswer({ ...result, kind: 'form' });
          if (answer.kind !== 'form' || !interactionFormAnswerMatchesRequest(projected, answer))
            throw new Error();
          if (answer.action !== 'accept') return { action: answer.action };
          return {
            action: 'accept',
            content: Object.fromEntries(
              Object.entries(answer.values).map(([name, value]) => [
                name,
                typeof value === 'object' ? [...value] : value,
              ]),
            ),
          };
        } catch {
          throw new Error('Invalid MCP form response');
        }
      },
    };
  } catch {
    throw new Error('Unsupported or invalid MCP form request');
  }
}
