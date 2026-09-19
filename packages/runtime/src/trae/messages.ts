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

import type {
  LanguageModelV4Prompt,
  LanguageModelV4FilePart,
  LanguageModelV4ToolResultOutput,
} from '@ai-sdk/provider';
import type { TraeModelConfig } from '@maka/core/llm-connections';
import { record } from './protocol.js';

type Content = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type Call = {
  index: number;
  id: string;
  type: 'function';
  function_call: { name: string; arguments: string };
};
export type TraeMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: Content[];
  tool_calls?: Call[];
  tool_call_id?: string;
  reasoning_content?: string;
};

export function traeMessages(prompt: LanguageModelV4Prompt, model: TraeModelConfig): TraeMessage[] {
  const messages: TraeMessage[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: [{ type: 'text', text: message.content }] });
      continue;
    }
    if (message.role === 'tool') {
      for (const part of message.content)
        if (part.type === 'tool-result')
          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: toolOutput(part.output, model.toolResponseImages),
          });
      continue;
    }
    const next: TraeMessage = { role: message.role, content: [] };
    for (const part of message.content) {
      if (part.type === 'text') next.content.push({ type: 'text', text: part.text });
      else if (part.type === 'file') next.content.push(fileContent(part));
      else if (part.type === 'reasoning' && model.function)
        next.reasoning_content = (next.reasoning_content ?? '') + part.text;
      else if (part.type === 'tool-call')
        (next.tool_calls ??= []).push({
          index: next.tool_calls?.length ?? 0,
          id: part.toolCallId,
          type: 'function',
          function_call: { name: part.toolName, arguments: JSON.stringify(part.input) },
        });
      // Reasoning belongs to the previous response and is never replayed as user text.
    }
    if (!next.content.length && !next.tool_calls?.length) continue;
    const previous = messages.at(-1);
    if (next.role === 'assistant' && previous?.role === 'assistant') {
      previous.content.push(...next.content);
      if (next.reasoning_content)
        previous.reasoning_content = (previous.reasoning_content ?? '') + next.reasoning_content;
      if (next.tool_calls) (previous.tool_calls ??= []).push(...next.tool_calls);
    } else messages.push(next);
  }
  // Tool results must immediately follow their owning assistant, in call order.
  const results = new Map(
    messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]),
  );
  return messages
    .filter((m) => m.role !== 'tool')
    .flatMap((message) => {
      const calls = message.tool_calls ?? [];
      calls.forEach((call, index) => {
        call.index = index;
      });
      return [
        message,
        ...calls
          .map((call) => results.get(call.id))
          .filter((m): m is TraeMessage => m !== undefined),
      ];
    });
}
function toolOutput(output: LanguageModelV4ToolResultOutput, images: boolean): Content[] {
  if (output.type === 'execution-denied')
    return [{ type: 'text', text: output.reason ?? 'Tool execution denied' }];
  if (output.type !== 'content')
    return [
      {
        type: 'text',
        text: typeof output.value === 'string' ? output.value : JSON.stringify(output.value),
      },
    ];
  return output.value.flatMap((part): Content[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type !== 'file') return [];
    if (part.mediaType.startsWith('image') && !images)
      return [{ type: 'text', text: '[This model cannot read images in tool results.]' }];
    return [fileContent(part)];
  });
}
function fileContent(file: Pick<LanguageModelV4FilePart, 'data' | 'mediaType'>): Content {
  if (file.data.type === 'text') return { type: 'text', text: file.data.text };
  if (!file.mediaType.startsWith('image'))
    throw new Error(`Trae does not support ${file.mediaType} files`);
  if (file.data.type === 'reference')
    throw new Error('Trae does not support provider file references');
  const url =
    file.data.type === 'url'
      ? String(file.data.url)
      : `data:${file.mediaType};base64,${typeof file.data.data === 'string' ? file.data.data : Buffer.from(file.data.data).toString('base64')}`;
  return { type: 'image_url', image_url: { url } };
}

const TRAE_SCHEMA_FORMATS: Record<string, ReadonlySet<string>> = {
  integer: new Set(['int32', 'int64']),
  number: new Set(['float', 'double']),
  string: new Set(['enum', 'date-time']),
};
const TRAE_SCHEMA_PASSTHROUGH = [
  'description',
  'enum',
  'maxItems',
  'minItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'minimum',
  'maximum',
  'propertyOrdering',
] as const;

function resolveLocalSchemaRef(ref: string, root: unknown): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const node = record(current);
    if (!node) return undefined;
    current = node[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return record(current);
}

/**
 * Project a JSON Schema onto the subset Trae forwards intact. Gemini-backed
 * routes receive tool parameters as `function_declarations` and reject every
 * keyword outside the OpenAPI schema subset (`exclusiveMinimum`, `const`,
 * `oneOf`, `$ref`, type arrays, unknown formats), which Trae surfaces as a
 * stream error 4027. Draft keywords are converted where a faithful equivalent
 * exists and dropped otherwise; property names and literal values never change.
 */
export function traeToolSchema(schema: unknown, root: unknown = schema, depth = 0): unknown {
  const value = record(schema);
  if (!value) return schema;
  if (depth < 16) {
    if (typeof value.$ref === 'string') {
      const { $ref, ...rest } = value;
      const target = resolveLocalSchemaRef($ref, root);
      return traeToolSchema(target ? { ...target, ...rest } : rest, root, depth + 1);
    }
    if (Array.isArray(value.allOf) && value.allOf.length === 1 && record(value.allOf[0])) {
      const { allOf, ...rest } = value;
      return traeToolSchema({ ...record(allOf[0]), ...rest }, root, depth + 1);
    }
  }
  const out: Record<string, unknown> = {};
  let nullable = value.nullable === true;
  let type = value.type;
  if (Array.isArray(type)) {
    const named = type.filter(
      (item): item is string => typeof item === 'string' && item !== 'null',
    );
    if (named.length !== type.length) nullable = true;
    type = named[0];
  }
  if (typeof type === 'string') out.type = type;
  for (const key of TRAE_SCHEMA_PASSTHROUGH) if (key in value) out[key] = value[key];
  if ('const' in value && !('enum' in value)) out.enum = [value.const];
  if (typeof value.exclusiveMinimum === 'number' && !('minimum' in value))
    out.minimum = type === 'integer' ? value.exclusiveMinimum + 1 : value.exclusiveMinimum;
  if (typeof value.exclusiveMaximum === 'number' && !('maximum' in value))
    out.maximum = type === 'integer' ? value.exclusiveMaximum - 1 : value.exclusiveMaximum;
  if (
    typeof value.format === 'string' &&
    typeof type === 'string' &&
    TRAE_SCHEMA_FORMATS[type]?.has(value.format)
  )
    out.format = value.format;
  const properties = record(value.properties);
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        traeToolSchema(child, root, depth + 1),
      ]),
    );
    if (out.type === undefined) out.type = 'object';
    if (Array.isArray(value.required)) {
      const required = value.required.filter(
        (name): name is string => typeof name === 'string' && name in properties,
      );
      if (required.length) out.required = required;
    }
  }
  const items = Array.isArray(value.items) ? value.items[0] : value.items;
  if (items !== undefined) {
    out.items = traeToolSchema(items, root, depth + 1);
    if (out.type === undefined) out.type = 'array';
  }
  const variants = Array.isArray(value.anyOf)
    ? value.anyOf
    : Array.isArray(value.oneOf)
      ? value.oneOf
      : undefined;
  if (variants) out.anyOf = variants.map((item) => traeToolSchema(item, root, depth + 1));
  // Gemini only enumerates strings and refuses a schema without `type`: infer
  // the type from the literals, keep string enums, and turn any other literal
  // set into a description hint rather than fail the whole turn.
  const literals = Array.isArray(out.enum) ? out.enum : undefined;
  const sample = literals?.find((item) => item !== null);
  if (literals && sample !== undefined && out.type === undefined) {
    out.type =
      typeof sample === 'number'
        ? Number.isInteger(sample)
          ? 'integer'
          : 'number'
        : typeof sample === 'boolean'
          ? 'boolean'
          : Array.isArray(sample)
            ? 'array'
            : typeof sample === 'object'
              ? 'object'
              : 'string';
  }
  if (literals) {
    const named = literals.filter((item) => item !== null);
    if (named.length !== literals.length) nullable = true;
    if (named.length === 0) delete out.enum;
    else if (named.every((item) => typeof item === 'string')) out.enum = named;
    else {
      delete out.enum;
      const hint = `Allowed values: ${named.map((item) => JSON.stringify(item)).join(', ')}.`;
      out.description = typeof out.description === 'string' ? `${out.description} ${hint}` : hint;
    }
  }
  if (out.type === undefined && !variants) out.type = 'string';
  if (nullable) out.nullable = true;
  return out;
}
