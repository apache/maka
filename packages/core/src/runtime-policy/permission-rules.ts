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
  isNormalizedAbsolutePath,
  pathWithinRoot,
  samePath,
  trimTrailingPathSeparators,
} from '../absolute-path.js';
import { assertCanonicalValue, domainError, exactRecord, stringValue } from './domain-codec.js';

export { pathWithinRoot as permissionPathWithinRoot } from '../absolute-path.js';

export const PERMISSION_RULES_MAX_COMMANDS = 128;
export const PERMISSION_RULES_MAX_PATHS = 128;
export const PERMISSION_RULE_MAX_COMMAND_LENGTH = 4_096;
export const PERMISSION_RULE_MAX_PATH_LENGTH = 4_096;

export interface PermissionPathRule {
  readonly path: string;
  readonly scope: 'exact' | 'subtree';
}

export interface PermissionRules {
  readonly denyCommands: readonly string[];
  readonly denyPaths: readonly PermissionPathRule[];
}

export type PermissionRuleMatch =
  | { readonly kind: 'command'; readonly pattern: string }
  | { readonly kind: 'path'; readonly rule: PermissionPathRule };

export interface CompiledPermissionRules {
  readonly rules: PermissionRules;
  match(request: PermissionRuleRequest): PermissionRuleMatch | undefined;
}

interface PermissionRuleRequest {
  readonly command?: string;
  readonly path?: string;
}

export const EMPTY_PERMISSION_RULES: PermissionRules = Object.freeze({
  denyCommands: Object.freeze([]),
  denyPaths: Object.freeze([]),
});

const compiledRulesCache = new WeakMap<object, CompiledPermissionRules>();

export function normalizePermissionRules(value: unknown): PermissionRules {
  const item = exactRecord(value, 'permission rules', ['denyCommands', 'denyPaths']);
  if (
    !Array.isArray(item.denyCommands) ||
    item.denyCommands.length > PERMISSION_RULES_MAX_COMMANDS
  ) {
    throw domainError(
      `permission rules denyCommands must contain no more than ${PERMISSION_RULES_MAX_COMMANDS} entries`,
    );
  }
  if (!Array.isArray(item.denyPaths) || item.denyPaths.length > PERMISSION_RULES_MAX_PATHS) {
    throw domainError(
      `permission rules denyPaths must contain no more than ${PERMISSION_RULES_MAX_PATHS} entries`,
    );
  }

  const denyCommands = [
    ...new Set(item.denyCommands.map((value, index) => normalizeCommandPattern(value, index))),
  ].sort((left, right) => left.localeCompare(right));
  const denyPaths = item.denyPaths
    .map((value, index) => normalizePathRule(value, index))
    .filter(
      (rule, index, rules) =>
        rules.findIndex(
          (candidate) => candidate.scope === rule.scope && samePath(candidate.path, rule.path),
        ) === index,
    )
    .sort(comparePathRules);

  return Object.freeze({
    denyCommands: Object.freeze(denyCommands),
    denyPaths: Object.freeze(denyPaths.map((rule) => Object.freeze(rule))),
  });
}

export function decodeCanonicalPermissionRules(value: unknown): PermissionRules {
  const decoded = normalizePermissionRules(value);
  assertCanonicalValue(value, decoded, 'permission rules');
  return decoded;
}

export function matchPermissionRules(
  rules: PermissionRules,
  request: PermissionRuleRequest,
): PermissionRuleMatch | undefined {
  return compilePermissionRules(rules).match(request);
}

/** Compile one immutable rule set once and reuse it for subsequent matches. */
export function compilePermissionRules(rules: PermissionRules): CompiledPermissionRules {
  const cached = compiledRulesCache.get(rules);
  if (cached) return cached;

  const commandMatchers = rules.denyCommands.map((pattern) => ({
    pattern,
    matcher: compileGlob(pattern),
  }));
  const compiled: CompiledPermissionRules = Object.freeze({
    rules,
    match(request: PermissionRuleRequest): PermissionRuleMatch | undefined {
      if (request.command !== undefined) {
        for (const entry of commandMatchers) {
          if (entry.matcher.test(request.command)) {
            return { kind: 'command', pattern: entry.pattern };
          }
        }
      }
      if (request.path !== undefined) {
        for (const rule of rules.denyPaths) {
          if (
            rule.scope === 'exact'
              ? samePath(rule.path, request.path)
              : pathWithinRoot(request.path, rule.path)
          ) {
            return { kind: 'path', rule };
          }
        }
      }
      return undefined;
    },
  });
  compiledRulesCache.set(rules, compiled);
  return compiled;
}

/** Compare canonical permission paths using the platform-aware path rules. */
export function samePermissionPath(left: string, right: string): boolean {
  return samePath(left, right);
}

function normalizeCommandPattern(value: unknown, index: number): string {
  const pattern = stringValue(
    value,
    `permission rules denyCommands[${index}]`,
    PERMISSION_RULE_MAX_COMMAND_LENGTH,
  ).trim();
  if (pattern.length === 0) {
    throw domainError(`permission rules denyCommands[${index}] must not be empty`);
  }
  if (/[^\x20-\x7e]/.test(pattern)) {
    throw domainError(
      `permission rules denyCommands[${index}] must contain printable characters only`,
    );
  }
  return pattern;
}

function normalizePathRule(value: unknown, index: number): PermissionPathRule {
  const item = exactRecord(value, `permission rules denyPaths[${index}]`, ['path', 'scope']);
  const rawPath = stringValue(
    item.path,
    `permission rules denyPaths[${index}].path`,
    PERMISSION_RULE_MAX_PATH_LENGTH,
  ).trim();
  const path = trimTrailingPathSeparators(rawPath);
  if (!isNormalizedAbsolutePath(path)) {
    throw domainError(
      `permission rules denyPaths[${index}].path must be a normalized absolute path`,
    );
  }
  if (item.scope !== 'exact' && item.scope !== 'subtree') {
    throw domainError(`permission rules denyPaths[${index}].scope is invalid`);
  }
  return { path, scope: item.scope };
}

function comparePathRules(left: PermissionPathRule, right: PermissionPathRule): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.scope === right.scope ? 0 : left.scope === 'subtree' ? -1 : 1)
  );
}

function compileGlob(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      source += '[\\s\\S]*';
    } else if (character === '?') {
      source += '[\\s\\S]';
    } else if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close > index + 1) {
        const body = pattern.slice(index + 1, close);
        if (/^[^\\\]]+$/.test(body)) {
          source += `[${body.replace(/[-^]/g, '\\$&')}]`;
          index = close;
          continue;
        }
      }
      source += '\\[';
    } else {
      source += escapeRegExp(character);
    }
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
