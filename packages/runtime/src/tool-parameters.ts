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

import Ajv, { type AnySchema, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

const jsonSchemaOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
} as const;
const draft7Validator = new Ajv(jsonSchemaOptions);
const draft2019Validator = new Ajv2019(jsonSchemaOptions);
const draft2020Validator = new Ajv2020(jsonSchemaOptions);
const compiledSchemas = new WeakMap<object, ValidateFunction>();

interface ToolParameterSchema {
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
  jsonSchema?: unknown;
  '~standard'?: {
    validate?: (
      value: unknown,
    ) =>
      | { value: unknown }
      | { issues: readonly unknown[] }
      | PromiseLike<{ value: unknown } | { issues: readonly unknown[] }>;
  };
}

export class ToolParameterValidationError extends Error {
  readonly issues: readonly unknown[];

  constructor(issues: readonly unknown[]) {
    super('Tool arguments failed declared schema validation', { cause: issues });
    this.name = 'ToolParameterValidationError';
    this.issues = issues;
  }
}

export async function parseToolParameters(parameters: unknown, input: unknown): Promise<unknown> {
  if (!parameters || (typeof parameters !== 'object' && typeof parameters !== 'function')) {
    return input;
  }
  const schema = parameters as ToolParameterSchema;
  if (typeof schema.safeParseAsync === 'function') {
    const parsed = await schema.safeParseAsync(input);
    if (parsed.success) return parsed.data;
    throw parsed.error;
  }
  if (typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw parsed.error;
  }
  if (typeof schema.validate === 'function') {
    const parsed = await schema.validate(input);
    if (parsed.success) return parsed.value;
    throw parsed.error;
  }
  if (typeof schema['~standard']?.validate === 'function') {
    const parsed = await schema['~standard'].validate(input);
    if ('value' in parsed) return parsed.value;
    throw new ToolParameterValidationError(parsed.issues);
  }

  const declaredJsonSchema = await schema.jsonSchema;
  const validator = compileJsonSchema(declaredJsonSchema ?? parameters);
  if (!validator || (await validator(input))) return input;
  throw new ToolParameterValidationError(validator.errors ?? []);
}

function compileJsonSchema(schema: unknown): ValidateFunction | undefined {
  if (typeof schema === 'boolean') return draft2020Validator.compile(schema);
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const cached = compiledSchemas.get(schema);
  if (cached) return cached;
  const declaredDialect = (schema as { readonly $schema?: unknown }).$schema;
  const dialect = typeof declaredDialect === 'string' ? declaredDialect : '';
  const validator = dialect.includes('draft-07')
    ? draft7Validator
    : dialect.includes('2019-09')
      ? draft2019Validator
      : draft2020Validator;
  const schemaForCompile = dialect.startsWith('https://json-schema.org/draft-07/schema')
    ? { ...schema, $schema: dialect.replace('https://', 'http://') }
    : schema;
  const compiled = validator.compile(schemaForCompile as AnySchema);
  compiledSchemas.set(schema, compiled);
  return compiled;
}
