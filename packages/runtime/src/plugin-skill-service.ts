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

import { Service, type Context } from './plugin-kernel.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';
import {
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
  MakaPluginRuntimeError,
} from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly skills: PluginSkillService;
  }
}

export interface PluginSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly declaredTools?: readonly string[];
  readonly requiredTools?: readonly string[];
  readonly modelInvocable?: boolean;
  readonly userInvocable?: boolean;
}

export interface PluginSkillInspection extends MakaContributionIdentity {
  readonly name: string;
}

interface RegisteredSkill extends MakaContributionIdentity {
  readonly definition: PluginSkillDefinition;
  readonly token: symbol;
  retired: boolean;
}

/** Profile/Session-scoped Skill contributions owned by the registering Fiber. */
export class PluginSkillService extends Service {
  private readonly registry = new PluginScopeRegistry<RegisteredSkill>();
  private revision = 0;

  constructor(ctx: Context) {
    super(ctx, 'skills');
  }

  register(definition: PluginSkillDefinition): () => Promise<void> {
    validateSkill(definition);
    const identity = pluginIdentity(this.ctx);
    if (identity.scopeId === 'desktop-ui')
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'desktop-ui plugins cannot register Host skills',
      );
    return registerPluginContribution(
      this.ctx,
      `skills.register(${JSON.stringify(definition.name)})`,
      () => {
        const rootId = identity.scopeId as MakaPluginRootId;
        const existing = this.registry.get(rootId, definition.name);
        if (existing && existing.entryId !== identity.entryId)
          throw new MakaPluginRuntimeError(
            'activation_failed',
            `Plugin Skill ${JSON.stringify(definition.name)} is already registered by ${existing.entryId}`,
          );
        const dispose = this.registry.publish(rootId, definition.name, {
          ...identity,
          definition: freezeSkill(definition),
          token: Symbol(definition.name),
          retired: false,
        });
        this.revision += 1;
        return async () => {
          await dispose();
          this.revision += 1;
        };
      },
    );
  }

  resolve(sessionId: string): readonly PluginSkillDefinition[] {
    return Object.freeze(
      [...this.registry.visible(assertScope(sessionId)).values()]
        .sort(compareIdentity)
        .map(({ definition }) => definition),
    );
  }

  get(sessionId: string, name: string): PluginSkillDefinition | undefined {
    return this.registry.visible(assertScope(sessionId)).get(name)?.definition;
  }

  snapshot(sessionId: string): {
    readonly revision: number;
    readonly skills: readonly PluginSkillDefinition[];
  } {
    return Object.freeze({ revision: this.revision, skills: this.resolve(sessionId) });
  }

  inspect(rootId?: MakaPluginRootId): readonly PluginSkillInspection[] {
    return Object.freeze(
      [...this.registry.entries(rootId)]
        .sort(compareIdentity)
        .map(({ definition, ...identity }) =>
          Object.freeze({ ...identity, name: definition.name }),
        ),
    );
  }
}

function validateSkill(value: PluginSkillDefinition): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.name))
    throw new TypeError('Plugin Skill name must be lower-kebab-case');
  if (!value.description.trim() || !value.instructions.trim())
    throw new TypeError('Plugin Skill description and instructions are required');
  if (value.instructions.length > 256 * 1024)
    throw new TypeError('Plugin Skill instructions exceed 256 KiB');
}

function freezeSkill(value: PluginSkillDefinition): PluginSkillDefinition {
  return Object.freeze({
    ...value,
    description: value.description.trim(),
    instructions: value.instructions,
    declaredTools: Object.freeze([...(value.declaredTools ?? [])]),
    requiredTools: Object.freeze([...(value.requiredTools ?? [])]),
  });
}

function assertScope(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new TypeError('Session id is invalid');
  return value;
}
function compareIdentity(left: MakaContributionIdentity, right: MakaContributionIdentity): number {
  return left.entryId.localeCompare(right.entryId) || left.generation - right.generation;
}
