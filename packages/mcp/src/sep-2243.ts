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

import { formatMcpDiagnosticText } from './diagnostic-text.js';

const X_MCP_HEADER = 'x-mcp-header';
const RFC_9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const UNREACHABLE_SCHEMA_KEYWORDS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'patternProperties',
  'dependentSchemas',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
] as const;

const SCHEMA_MAP_KEYWORDS = new Set([
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);

const WARNING_SAMPLE_LIMIT = 5;
export const MCP_HEADER_WARNING_LENGTH_LIMIT = 512;

export type McpHeaderPrimitiveType = 'string' | 'integer' | 'boolean';

export type McpHeaderDefinitionReasonCode =
  | 'not_statically_reachable'
  | 'annotation_not_string'
  | 'header_name_empty'
  | 'header_name_invalid'
  | 'property_type_unsupported'
  | 'header_name_duplicate';

export interface McpHeaderDeclaration {
  readonly path: readonly string[];
  readonly headerName: string;
  readonly type: McpHeaderPrimitiveType;
}

export interface McpHeaderDefinitionIssue {
  readonly code: McpHeaderDefinitionReasonCode;
  readonly path: readonly string[];
}

export type McpHeaderDefinitionValidation =
  | {
      readonly valid: true;
      readonly declarations: readonly McpHeaderDeclaration[];
    }
  | {
      readonly valid: false;
      readonly issue: McpHeaderDefinitionIssue;
    };

export interface McpHeaderToolDefinitionLike {
  readonly name: string;
  readonly inputSchema: unknown;
}

export interface ValidMcpHeaderTool<T extends McpHeaderToolDefinitionLike> {
  readonly tool: T;
  readonly declarations: readonly McpHeaderDeclaration[];
}

export interface McpHeaderToolRejection {
  readonly toolName: string;
  readonly issue: McpHeaderDefinitionIssue;
}

export interface McpHeaderToolPartition<T extends McpHeaderToolDefinitionLike> {
  readonly valid: readonly ValidMcpHeaderTool<T>[];
  readonly rejected: readonly McpHeaderToolRejection[];
}

export type McpHeaderArgumentValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code: 'unsafe_integer_argument';
      readonly path: readonly string[];
    };

/**
 * Validate the narrow SEP-2243 schema extension without becoming a general
 * JSON Schema evaluator. A declaration is reachable only through `properties`
 * keys; finding one in a dynamic or composed subschema invalidates the Tool.
 */
export function validateMcpHeaderDefinition(inputSchema: unknown): McpHeaderDefinitionValidation {
  const declarations: McpHeaderDeclaration[] = [];
  const headerPaths = new Map<string, readonly string[]>();

  const visit = (
    value: unknown,
    path: readonly string[],
    staticallyReachable: boolean,
  ): McpHeaderDefinitionIssue | undefined => {
    if (!isRecord(value)) return undefined;

    if (X_MCP_HEADER in value) {
      if (!staticallyReachable || path.length === 0) {
        return { code: 'not_statically_reachable', path };
      }

      const headerName = value[X_MCP_HEADER];
      if (typeof headerName !== 'string') {
        return { code: 'annotation_not_string', path };
      }
      if (headerName.length === 0) {
        return { code: 'header_name_empty', path };
      }
      if (!RFC_9110_TOKEN.test(headerName)) {
        return { code: 'header_name_invalid', path };
      }

      const type = value.type;
      if (!isMcpHeaderPrimitiveType(type)) {
        return { code: 'property_type_unsupported', path };
      }

      const normalizedHeaderName = headerName.toLowerCase();
      if (headerPaths.has(normalizedHeaderName)) {
        return { code: 'header_name_duplicate', path };
      }
      headerPaths.set(normalizedHeaderName, path);
      declarations.push({ path, headerName, type });
    }

    if (isRecord(value.properties)) {
      for (const [propertyName, propertySchema] of Object.entries(value.properties)) {
        const issue = visit(propertySchema, [...path, propertyName], staticallyReachable);
        if (issue) return issue;
      }
    }

    for (const keyword of UNREACHABLE_SCHEMA_KEYWORDS) {
      const subschema = value[keyword];
      if (subschema === undefined) continue;
      const branches =
        Array.isArray(subschema) || !SCHEMA_MAP_KEYWORDS.has(keyword) || !isRecord(subschema)
          ? asArray(subschema)
          : Object.values(subschema);
      for (const branch of branches) {
        const issue = visit(branch, [...path, `<${keyword}>`], false);
        if (issue) return issue;
      }
    }

    return undefined;
  };

  const issue = visit(inputSchema, [], true);
  return issue ? { valid: false, issue } : { valid: true, declarations };
}

/**
 * Partition independently so one malformed server Tool cannot hide valid
 * siblings. The returned Tool references are unchanged.
 */
export function partitionMcpHeaderToolDefinitions<T extends McpHeaderToolDefinitionLike>(
  tools: readonly T[],
): McpHeaderToolPartition<T> {
  const valid: ValidMcpHeaderTool<T>[] = [];
  const rejected: McpHeaderToolRejection[] = [];

  for (const tool of tools) {
    const validation = validateMcpHeaderDefinition(tool.inputSchema);
    if (validation.valid) {
      valid.push({ tool, declarations: validation.declarations });
    } else {
      rejected.push({ toolName: tool.name, issue: validation.issue });
    }
  }

  return { valid, rejected };
}

/**
 * Produce one log-safe diagnostic per refresh. It exposes stable reason codes,
 * never raw schemas or arguments, and remains bounded even for hostile names.
 */
export function formatMcpHeaderExclusionWarning(
  rejections: readonly McpHeaderToolRejection[],
): string | undefined {
  if (rejections.length === 0) return undefined;

  const candidates = rejections
    .slice(0, WARNING_SAMPLE_LIMIT)
    .map(
      ({ toolName, issue }) =>
        `${JSON.stringify(formatMcpDiagnosticText(toolName))} [${issue.code}]`,
    );
  const prefix =
    `MCP tool discovery excluded ${rejections.length} Tool definition(s) with invalid ` +
    'x-mcp-header annotations';

  // Reserve room for the omitted count and prefer fewer complete samples over
  // slicing through a Tool name or stable reason code.
  for (let sampleCount = candidates.length; sampleCount >= 0; sampleCount -= 1) {
    const omitted = rejections.length - sampleCount;
    const sample = candidates.slice(0, sampleCount).join(', ');
    const detail = sample ? `: ${sample}` : '';
    const suffix = omitted > 0 ? `; ${omitted} more not shown` : '';
    const warning = `${prefix}${detail}${suffix}`;
    if (warning.length <= MCP_HEADER_WARNING_LENGTH_LIMIT) return warning;
  }

  return truncateRenderedWarning(prefix);
}

/**
 * Enforce the SEP-2243 safe-integer rule after arguments exist but before the
 * caller enters the HTTP transport.
 */
export function validateMcpHeaderArguments(
  declarations: readonly McpHeaderDeclaration[],
  args: Readonly<Record<string, unknown>>,
): McpHeaderArgumentValidation {
  for (const declaration of declarations) {
    if (declaration.type !== 'integer') continue;
    const value = valueAtPath(args, declaration.path);
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return {
        valid: false,
        code: 'unsafe_integer_argument',
        path: declaration.path,
      };
    }
  }
  return { valid: true };
}

function isMcpHeaderPrimitiveType(value: unknown): value is McpHeaderPrimitiveType {
  return value === 'string' || value === 'integer' || value === 'boolean';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const segment of path) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function truncateRenderedWarning(value: string): string {
  if (value.length <= MCP_HEADER_WARNING_LENGTH_LIMIT) return value;
  const end = MCP_HEADER_WARNING_LENGTH_LIMIT - 1;
  const safeEnd = end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? '') ? end - 1 : end;
  return `${value.slice(0, safeEnd)}\u2026`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
