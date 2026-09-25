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

import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  pluginIdentity,
  registerPluginContribution,
  validatePluginRootId,
  type MakaContributionIdentity,
} from './plugin-runtime.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly turns: PluginTurnFinishService;
  }
}

export interface TurnFinishContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export type TurnFinishDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly feedback: string };

export interface TurnFinishCheck {
  readonly name: string;
  check(context: TurnFinishContext): TurnFinishDecision | Promise<TurnFinishDecision>;
}

interface RegisteredCheck extends MakaContributionIdentity {
  readonly definition: TurnFinishCheck;
  readonly token: symbol;
  retired: boolean;
}

/** A scoped, plugin-owned check at a model's natural end-of-turn boundary. */
export class PluginTurnFinishService extends Service {
  private readonly checks = new PluginScopeRegistry<RegisteredCheck>();

  constructor(ctx: Context) {
    super(ctx, 'turns');
  }

  beforeFinish(definition: TurnFinishCheck): Disposable<Promise<void>> {
    const identity = pluginIdentity(this.ctx);
    const rootId = identity.scopeId;
    validatePluginRootId(rootId);
    if (!/^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u.test(definition.name)) {
      throw new TypeError('Turn finish check name is invalid');
    }
    if (typeof definition.check !== 'function') {
      throw new TypeError('Turn finish check handler is required');
    }
    return registerPluginContribution(
      this.ctx,
      `turns.beforeFinish(${JSON.stringify(definition.name)})`,
      () =>
        this.checks.publish(rootId, definition.name, {
          ...identity,
          definition,
          token: Symbol(definition.name),
          retired: false,
        }),
    );
  }

  async evaluate(context: TurnFinishContext): Promise<TurnFinishDecision> {
    const visible = [...this.checks.visible(context.sessionId).values()].sort((a, b) =>
      a.definition.name.localeCompare(b.definition.name),
    );
    for (const entry of visible) {
      if (context.signal.aborted) return { allow: true };
      const decision = await entry.definition.check(context);
      if (decision?.allow === true) continue;
      if (
        decision?.allow !== false ||
        typeof decision.feedback !== 'string' ||
        !decision.feedback.trim() ||
        decision.feedback.length > 2000
      ) {
        throw new TypeError(
          `Turn finish check ${entry.definition.name} returned an invalid decision`,
        );
      }
      return { allow: false, feedback: decision.feedback.trim() };
    }
    return { allow: true };
  }
}
