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
 * Provider-visible tool schema planning and Code Mode schema validation.
 * Tool execution and settlement remain owned by AiSdkTurn and ToolRuntime.
 */

import { DEFAULT_TOOL_MODE, isToolMode, type ToolMode } from '@maka/core/tool-mode';
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

import type { ModelToolSet } from './model-protocol.js';
import { toolSchemaCharsForDiagnostics } from './request-shape.js';
import { INVALID_TOOL_NAME } from './ai-sdk-tool-repair.js';
import type { MakaTool } from './tool-runtime.js';
import type { ToolAvailabilityPlan } from './tool-availability.js';

export interface ToolSchemaPlan {
  toolMode: ToolMode;
  availability: ToolAvailabilityPlan;
  providerTools: MakaTool[];
  modelTools: ModelToolSet;
}

export function buildToolSchemaPlan(input: {
  boundTools: readonly MakaTool[];
  availability: ToolAvailabilityPlan;
  requestedToolMode: unknown;
  codeModeExecTool: MakaTool;
}): ToolSchemaPlan {
  const requestedToolMode =
    input.requestedToolMode === undefined ? DEFAULT_TOOL_MODE : input.requestedToolMode;
  if (!isToolMode(requestedToolMode)) {
    throw new Error(`Invalid tool mode: ${String(requestedToolMode)}`);
  }
  if (
    requestedToolMode === 'code_mode' &&
    input.boundTools.some((tool) => tool.name === input.codeModeExecTool.name)
  ) {
    throw new Error(`Tool name "${input.codeModeExecTool.name}" is reserved for Code Mode.`);
  }

  const availability = projectToolModePlan(
    input.availability,
    requestedToolMode,
    input.codeModeExecTool,
  );
  return {
    toolMode: requestedToolMode,
    availability,
    providerTools: availability.providerTools,
    modelTools: bindModelTools(availability.providerTools),
  };
}

export function buildNestableToolSnapshot(
  providerTools: readonly MakaTool[],
  activeToolNames: readonly string[],
): ReadonlyMap<string, MakaTool> {
  const active = new Set(activeToolNames);
  return new Map(
    providerTools
      .filter(
        (tool) =>
          active.has(tool.name) &&
          tool.name !== INVALID_TOOL_NAME &&
          tool.name !== 'exec' &&
          tool.providerTool === undefined &&
          tool.nesting !== 'direct_only',
      )
      .map((tool) => [tool.name, tool] as const),
  );
}

export async function validateCodeModeToolInput(tool: MakaTool, input: unknown): Promise<unknown> {
  const parameters = tool.parameters as {
    safeParseAsync?: (
      value: unknown,
    ) => Promise<{ success: true; data: unknown } | { success: false; error: unknown }>;
    safeParse?: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false; error: unknown };
    validate?: (
      value: unknown,
    ) =>
      | { success: true; value: unknown }
      | { success: false; error: unknown }
      | Promise<{ success: true; value: unknown } | { success: false; error: unknown }>;
    jsonSchema?: unknown;
  };
  const parserResult = parameters.safeParseAsync
    ? await parameters.safeParseAsync(input)
    : parameters.safeParse?.(input);
  if (parserResult) {
    if (parserResult.success) return parserResult.data;
    throw invalidCodeModeToolArguments(tool.name, parserResult.error);
  }

  if (parameters.validate) {
    const validationResult = await parameters.validate(input);
    if (validationResult.success) return validationResult.value;
    throw invalidCodeModeToolArguments(tool.name, validationResult.error);
  }

  const schema = await parameters.jsonSchema;
  const validator = compileCodeModeJsonSchema(schema ?? tool.parameters);
  if (!validator || validator(input)) return input;
  throw invalidCodeModeToolArguments(tool.name, validator.errors);
}

function projectToolModePlan(
  plan: ToolAvailabilityPlan,
  toolMode: ToolMode,
  execTool: MakaTool,
): ToolAvailabilityPlan {
  if (toolMode === 'direct') return plan;
  const withExec = (names: readonly string[]): string[] =>
    [...new Set([...names, execTool.name])].sort((a, b) => a.localeCompare(b));
  const invalid = plan.providerTools.filter((tool) => tool.name === INVALID_TOOL_NAME);
  const visible = [
    ...plan.providerTools.filter((tool) => tool.name !== INVALID_TOOL_NAME),
    execTool,
  ].sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...plan,
    providerTools: [...visible, ...invalid],
    activeTools: withExec(plan.activeTools),
    ...(plan.projectActiveTools
      ? {
          projectActiveTools: (options) => ({
            activeTools: withExec(plan.projectActiveTools?.(options).activeTools ?? []),
          }),
        }
      : {}),
    currentRepairToolNames: () => withExec(plan.currentRepairToolNames()),
    diagnostics: (activeTools, visibleToolSchemaChars) => {
      const baseActive = activeTools.filter((name) => name !== execTool.name);
      const baseChars = toolSchemaCharsForDiagnostics(plan.providerTools, baseActive);
      const diagnostic = plan.diagnostics(baseActive, baseChars);
      if (!diagnostic) return undefined;
      const execSchemaChars = Math.max(0, visibleToolSchemaChars - baseChars);
      return {
        ...diagnostic,
        visibleToolCount: (diagnostic.visibleToolCount ?? baseActive.length) + 1,
        fullToolCount:
          (diagnostic.fullToolCount ?? baseActive.length + (diagnostic.hiddenToolCount ?? 0)) + 1,
        visibleToolSchemaChars,
        fullToolSchemaChars:
          (diagnostic.fullToolSchemaChars ??
            baseChars + (diagnostic.toolSchemaCharReduction ?? 0)) + execSchemaChars,
      };
    },
  };
}

function bindModelTools(providerTools: readonly MakaTool[]): ModelToolSet {
  const modelTools: ModelToolSet = {};
  for (const tool of providerTools) {
    modelTools[tool.name] = tool.providerTool
      ? { kind: 'provider', providerTool: tool.providerTool }
      : {
          kind: 'function',
          description: tool.description,
          inputSchema: tool.parameters,
        };
  }
  return modelTools;
}

const codeModeJsonSchemaOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
} as const;
const codeModeDraft7Validator = new Ajv(codeModeJsonSchemaOptions);
const codeModeDraft2019Validator = new Ajv2019(codeModeJsonSchemaOptions);
const codeModeDraft2020Validator = new Ajv2020(codeModeJsonSchemaOptions);
const codeModeCompiledSchemas = new WeakMap<object, ValidateFunction>();

function compileCodeModeJsonSchema(schema: unknown): ValidateFunction | undefined {
  if (typeof schema === 'boolean') return codeModeDraft2020Validator.compile(schema);
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const cached = codeModeCompiledSchemas.get(schema);
  if (cached) return cached;
  const declaredDialect = (schema as { readonly $schema?: unknown }).$schema;
  const dialect = typeof declaredDialect === 'string' ? declaredDialect : '';
  const validator = dialect.includes('draft-07')
    ? codeModeDraft7Validator
    : dialect.includes('2019-09')
      ? codeModeDraft2019Validator
      : codeModeDraft2020Validator;
  const schemaForCompile = dialect.startsWith('https://json-schema.org/draft-07/schema')
    ? { ...schema, $schema: dialect.replace('https://', 'http://') }
    : schema;
  const compiled = validator.compile(schemaForCompile as AnySchema);
  codeModeCompiledSchemas.set(schema, compiled);
  return compiled;
}

function invalidCodeModeToolArguments(toolName: string, error: unknown): Error {
  return new Error(`Invalid arguments for tool "${toolName}": ${schemaErrorSummary(error)}`);
}

function schemaErrorSummary(error: unknown): string {
  if (error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)) {
    const issues = (error as { issues: Array<{ path?: unknown; message?: unknown }> }).issues;
    return issues
      .slice(0, 5)
      .map((issue) => {
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
        const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
        return path ? `${path}: ${message}` : message;
      })
      .join('; ')
      .slice(0, 1000);
  }
  if (Array.isArray(error)) {
    return (error as ErrorObject[])
      .slice(0, 5)
      .map((issue) => {
        const path = issue.instancePath || issue.schemaPath;
        return `${path || 'input'} ${issue.message ?? 'is invalid'}`;
      })
      .join('; ')
      .slice(0, 1000);
  }
  return 'input does not match the declared schema';
}
