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

import { createHash } from 'node:crypto';
import { Service, type Awaitable, type Context, type Disposable } from './plugin-kernel.js';
import {
  MakaPluginRuntimeError,
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
} from './plugin-runtime.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly systemPrompt: PluginSystemPromptService;
  }
}

const PROMPT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u;
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const VARIABLE_REFERENCE_PATTERN = /\{\{([^{}]*)\}\}/gu;
const HOST_BASE_SECTION = 'maka:base';

export const PLUGIN_SYSTEM_PROMPT_SOURCE_ID = 'plugin.system-prompt';

export interface PluginSystemPromptContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
}

export type PluginSystemPromptText =
  | string
  | ((context: PluginSystemPromptContext) => Awaitable<string | undefined>);

export interface PluginSystemPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: PluginSystemPromptText;
  /** Replaces the Host base and every non-complete section for this scope. */
  readonly complete?: boolean;
}

export type PluginSystemPromptVariableProvider = (
  context: PluginSystemPromptContext,
) => Awaitable<string | undefined>;

export interface PluginSystemPromptAssembly {
  readonly text: string | undefined;
  readonly sourceRevision?: { readonly id: string; readonly revision: string };
}

export interface PluginSystemPromptInspection extends MakaContributionIdentity {
  readonly kind: 'section' | 'variable';
  readonly name: string;
  readonly order?: number;
  readonly complete?: boolean;
}

interface RegisteredSection extends MakaContributionIdentity {
  readonly definition: PluginSystemPromptSection;
  readonly token: symbol;
  retired: boolean;
}

interface RegisteredVariable extends MakaContributionIdentity {
  readonly name: string;
  readonly provider: PluginSystemPromptVariableProvider;
  readonly token: symbol;
  retired: boolean;
}

interface ResolvedSection extends MakaContributionIdentity {
  readonly name: string;
  readonly order: number;
  readonly text: string;
  readonly complete: boolean;
}

/**
 * Context-scoped, Fiber-owned System Prompt registry for trusted Host plugins.
 *
 * Profile contributions are inherited by Session roots. A Session contribution
 * with the same name shadows its Profile counterpart before either provider is
 * evaluated. Every assembly snapshots membership and resolves providers anew,
 * so changes committed by one tool call appear at the next logical model step.
 */
export class PluginSystemPromptService extends Service {
  private readonly sections = new PluginScopeRegistry<RegisteredSection>();
  private readonly variables = new PluginScopeRegistry<RegisteredVariable>();

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt');
  }

  section(definition: PluginSystemPromptSection): Disposable<Promise<void>> {
    const identity = pluginIdentity(this.ctx);
    assertHostPromptScope(identity.scopeId);
    validateSection(definition);
    return registerPluginContribution(
      this.ctx,
      `systemPrompt.section(${JSON.stringify(definition.name)})`,
      () => this.publishSection(identity, definition),
    );
  }

  variable(name: string, provider: PluginSystemPromptVariableProvider): Disposable<Promise<void>> {
    const identity = pluginIdentity(this.ctx);
    assertHostPromptScope(identity.scopeId);
    validateVariable(name, provider);
    return registerPluginContribution(
      this.ctx,
      `systemPrompt.variable(${JSON.stringify(name)})`,
      () => this.publishVariable(identity, name, provider),
    );
  }

  async assemble(
    context: PluginSystemPromptContext,
    baseText: string | undefined,
  ): Promise<PluginSystemPromptAssembly> {
    validateAssemblyContext(context);
    const visibleSections = this.sections.visible(context.sessionId);
    const visibleVariables = this.variables.visible(context.sessionId);
    const sectionSnapshot = [...visibleSections.values()];
    const variableSnapshot = [...visibleVariables.values()];

    if (sectionSnapshot.length === 0 && variableSnapshot.length === 0) {
      return Object.freeze({ text: baseText });
    }

    const variables: Record<string, string | undefined> = {};
    for (const variable of variableSnapshot.sort(compareRegistration)) {
      const value = await variable.provider(context);
      if (value !== undefined && typeof value !== 'string') {
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `System Prompt variable ${JSON.stringify(variable.name)} returned a non-string value`,
        );
      }
      variables[variable.name] = value;
    }
    const resolved: ResolvedSection[] = [];
    for (const section of sectionSnapshot) {
      const value =
        typeof section.definition.text === 'string'
          ? section.definition.text
          : await section.definition.text(context);
      if (value !== undefined && typeof value !== 'string') {
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `System Prompt section ${JSON.stringify(section.definition.name)} returned a non-string value`,
        );
      }
      resolved.push({
        ...section,
        name: section.definition.name,
        order: section.definition.order,
        text: value ?? '',
        complete: section.definition.complete === true,
      });
    }
    const complete = resolved.filter((section) => section.complete);
    if (complete.length > 1) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Multiple complete System Prompt sections are active: ${complete
          .map(({ name }) => JSON.stringify(name))
          .sort()
          .join(', ')}`,
      );
    }
    const effective = complete.length
      ? complete
      : [
          ...(baseText === undefined
            ? []
            : [
                {
                  entryId: HOST_BASE_SECTION,
                  scopeId: 'profile',
                  extensionId: 'maka',
                  generation: 0,
                  name: HOST_BASE_SECTION,
                  order: 0,
                  text: baseText,
                  complete: false,
                } satisfies ResolvedSection,
              ]),
          ...resolved,
        ];
    const rendered = effective
      .sort(compareSections)
      .map((section) => interpolate(section.name, section.text, variables))
      .filter(Boolean)
      .join('\n\n');
    const revision = promptRevision(resolved, variableSnapshot, variables);
    return Object.freeze({
      text: rendered || undefined,
      sourceRevision: Object.freeze({
        id: PLUGIN_SYSTEM_PROMPT_SOURCE_ID,
        revision,
      }),
    });
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginSystemPromptInspection[] {
    return Object.freeze(
      [
        ...this.sections.entries(rootId).map((entry) => ({
          entryId: entry.entryId,
          scopeId: entry.scopeId,
          extensionId: entry.extensionId,
          generation: entry.generation,
          kind: 'section' as const,
          name: entry.definition.name,
          order: entry.definition.order,
          complete: entry.definition.complete === true,
        })),
        ...this.variables.entries(rootId).map((entry) => ({
          entryId: entry.entryId,
          scopeId: entry.scopeId,
          extensionId: entry.extensionId,
          generation: entry.generation,
          kind: 'variable' as const,
          name: entry.name,
        })),
      ].sort(compareInspection),
    );
  }

  private publishSection(
    identity: MakaContributionIdentity,
    definition: PluginSystemPromptSection,
  ): Disposable<Promise<void>> {
    const rootId = identity.scopeId as MakaPluginRootId;
    const existing = this.sections.get(rootId, definition.name);
    assertOwner(existing, identity, 'section', definition.name);
    const entry: RegisteredSection = {
      ...identity,
      definition: Object.freeze({ ...definition }),
      token: Symbol(definition.name),
      retired: false,
    };
    return this.sections.publish(rootId, definition.name, entry);
  }

  private publishVariable(
    identity: MakaContributionIdentity,
    name: string,
    provider: PluginSystemPromptVariableProvider,
  ): Disposable<Promise<void>> {
    const rootId = identity.scopeId as MakaPluginRootId;
    const existing = this.variables.get(rootId, name);
    assertOwner(existing, identity, 'variable', name);
    const entry: RegisteredVariable = {
      ...identity,
      name,
      provider,
      token: Symbol(name),
      retired: false,
    };
    return this.variables.publish(rootId, name, entry);
  }
}

function assertHostPromptScope(scopeId: string): void {
  if (scopeId === 'desktop-ui') {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'desktop-ui plugins cannot contribute Host System Prompt sections',
    );
  }
}

function validateSection(section: PluginSystemPromptSection): void {
  validateName(section.name, 'System Prompt section');
  if (section.name === HOST_BASE_SECTION) {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'The Host base System Prompt is reserved',
    );
  }
  if (!Number.isFinite(section.order)) {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'System Prompt section order must be finite',
    );
  }
  if (typeof section.text !== 'string' && typeof section.text !== 'function') {
    throw new MakaPluginRuntimeError('activation_failed', 'System Prompt section text is invalid');
  }
}

function validateVariable(name: string, provider: PluginSystemPromptVariableProvider): void {
  if (!VARIABLE_NAME_PATTERN.test(name) || Buffer.byteLength(name, 'utf8') > 128) {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      `Invalid System Prompt variable: ${name}`,
    );
  }
  if (typeof provider !== 'function') {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'System Prompt variable provider is invalid',
    );
  }
}

function validateName(name: string, label: string): void {
  if (!PROMPT_NAME_PATTERN.test(name) || Buffer.byteLength(name, 'utf8') > 128) {
    throw new MakaPluginRuntimeError('activation_failed', `Invalid ${label} name: ${name}`);
  }
}

function validateAssemblyContext(context: PluginSystemPromptContext): void {
  if (
    !context.sessionId ||
    !context.turnId ||
    !context.cwd ||
    /[\0\r\n]/u.test(context.sessionId) ||
    /[\0\r\n]/u.test(context.turnId)
  ) {
    throw new Error('Invalid System Prompt assembly context');
  }
}

function assertOwner(
  current: MakaContributionIdentity | undefined,
  identity: MakaContributionIdentity,
  kind: string,
  name: string,
): void {
  if (current && current.entryId !== identity.entryId) {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      `System Prompt ${kind} ${JSON.stringify(name)} is already registered by ${current.entryId}`,
    );
  }
}

function interpolate(
  sectionName: string,
  text: string,
  variables: Readonly<Record<string, string | undefined>>,
): string {
  VARIABLE_REFERENCE_PATTERN.lastIndex = 0;
  return text.replace(VARIABLE_REFERENCE_PATTERN, (reference, rawName: string) => {
    if (!VARIABLE_NAME_PATTERN.test(rawName)) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Malformed System Prompt variable ${JSON.stringify(reference)} in section ${JSON.stringify(sectionName)}`,
      );
    }
    if (!Object.hasOwn(variables, rawName)) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Unknown System Prompt variable ${JSON.stringify(rawName)} in section ${JSON.stringify(sectionName)}`,
      );
    }
    const value = variables[rawName];
    if (value === undefined) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `System Prompt variable ${JSON.stringify(rawName)} has no value in section ${JSON.stringify(sectionName)}`,
      );
    }
    return value;
  });
}

function promptRevision(
  sections: readonly ResolvedSection[],
  variables: readonly RegisteredVariable[],
  values: Readonly<Record<string, string | undefined>>,
): string {
  const canonical = {
    sections: [...sections].sort(compareSections).map((section) => ({
      scopeId: section.scopeId,
      entryId: section.entryId,
      extensionId: section.extensionId,
      generation: section.generation,
      name: section.name,
      order: section.order,
      complete: section.complete,
      text: section.text,
    })),
    variables: [...variables].sort(compareRegistration).map((variable) => ({
      scopeId: variable.scopeId,
      entryId: variable.entryId,
      extensionId: variable.extensionId,
      generation: variable.generation,
      name: variable.name,
      value: values[variable.name] ?? null,
    })),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function compareSections(left: ResolvedSection, right: ResolvedSection): number {
  return left.order - right.order || compareCodeUnits(left.name, right.name);
}

function compareRegistration(
  left: MakaContributionIdentity,
  right: MakaContributionIdentity,
): number {
  return (
    compareCodeUnits(left.scopeId, right.scopeId) ||
    compareCodeUnits(left.entryId, right.entryId) ||
    left.generation - right.generation
  );
}

function compareInspection(
  left: PluginSystemPromptInspection,
  right: PluginSystemPromptInspection,
): number {
  return (
    compareCodeUnits(left.scopeId, right.scopeId) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.entryId, right.entryId)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
