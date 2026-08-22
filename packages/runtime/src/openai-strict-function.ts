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

export interface OpenAIStrictFunctionProjection {
  args: Record<string, unknown>;
  discardedKeys: string[];
}

export function createOpenAIStrictObjectSchema(input: {
  properties: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(input.properties).map(([key, schema]) => [
        key,
        key === 'action' ? schema : nullableSchema(schema),
      ]),
    ),
    required: Object.keys(input.properties),
    additionalProperties: false,
  };
}

export function projectOpenAIStrictFunctionArgs(input: {
  value: unknown;
  knownKeys: readonly string[];
  allowedKeysByAction: Readonly<Record<string, readonly string[]>>;
}): OpenAIStrictFunctionProjection {
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) {
    throw new Error('openai_strict_function_args_not_object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input.value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw new Error(`openai_strict_function_arg_not_data_property:${key}`);
    }
  }
  const record = input.value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !input.knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`openai_strict_function_unknown_keys:${unknownKeys.sort().join(',')}`);
  }
  const action = record.action;
  if (typeof action !== 'string') {
    throw new Error('openai_strict_function_missing_action');
  }
  const allowedKeys = input.allowedKeysByAction[action];
  if (!allowedKeys) {
    throw new Error(`openai_strict_function_unknown_action:${action}`);
  }
  const args = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => value !== null && allowedKeys.includes(key)),
  );
  const discardedKeys = Object.entries(record)
    .filter(([key, value]) => value !== null && !allowedKeys.includes(key))
    .map(([key]) => key)
    .sort();
  return { args, discardedKeys };
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema.type;
  if (typeof type === 'string') {
    return { ...schema, type: [type, 'null'] };
  }
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}
