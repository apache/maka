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
import type { PluginAgentService } from './plugin-agent-service.js';
import type { PluginSessionQueryCaller } from './plugin-session-query-service.js';
import {
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
} from './plugin-runtime.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly sources: PluginSourceService;
  }
}

/** Native locators remain adapter-owned; IDs include account/tenant identity via source.id. */
export interface SourceObject {
  readonly id: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly kind: string;
  readonly title?: string;
  readonly url?: string;
  readonly updatedAt?: number;
}
export interface SourcePage {
  readonly items: readonly SourceObject[];
  readonly next?: string;
}
export interface SourceRead {
  readonly status: 'ok' | 'deleted' | 'unavailable' | 'version_unavailable';
  readonly object?: SourceObject;
  readonly content?: unknown;
}
export interface PluginSourceAdapter {
  readonly id: string;
  readonly description: string;
  /** Describes provider-supported query fields and the configured enumeration scope. */
  readonly queryHelp: string;
  readonly scope: Readonly<Record<string, unknown>>;
  /** Enumerates metadata only. Pagination is not an index coverage declaration. */
  enumerate(cursor: string | undefined, caller: PluginSessionQueryCaller): Promise<SourcePage>;
  query(
    request: Readonly<Record<string, unknown>>,
    caller: PluginSessionQueryCaller,
  ): Promise<SourcePage>;
  /** Must check current read permission, even for locally cached evidence. Errors fail closed. */
  authorize(
    objects: readonly SourceObject[],
    caller: PluginSessionQueryCaller,
  ): Promise<readonly string[]>;
  read(object: SourceObject, caller: PluginSessionQueryCaller): Promise<SourceRead>;
}

interface RegisteredSource extends MakaContributionIdentity {
  readonly adapter: PluginSourceAdapter;
  readonly token: symbol;
  retired: boolean;
}

/** Generic read-only provider registry. No credentials, bodies or provider SDKs enter indexes. */
export class PluginSourceService extends Service {
  private readonly adapters = new PluginScopeRegistry<RegisteredSource>();
  constructor(
    ctx: Context,
    private readonly agents: PluginAgentService,
  ) {
    super(ctx, 'sources');
  }
  register(adapter: PluginSourceAdapter): Disposable<Promise<void>> {
    if (this.ctx.maka && this.ctx.maka.rootId !== 'profile')
      throw Error('Sources require profile scope');
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(adapter.id) || adapter.id === 'maka')
      throw Error('Invalid or reserved source ID');
    const identity = pluginIdentity(this.ctx);
    return registerPluginContribution(this.ctx, `source:${adapter.id}`, () => {
      const existing = this.adapters.get('profile', adapter.id);
      if (existing && existing.entryId !== identity.entryId)
        throw Error('Source already registered by another entry');
      return this.adapters.publish('profile', adapter.id, {
        ...identity,
        adapter,
        token: Symbol(adapter.id),
        retired: false,
      });
    });
  }

  list() {
    this.caller();
    return this.adapters
      .entries('profile')
      .map(({ adapter: { id, description, queryHelp, scope } }) => ({
        id,
        description,
        queryHelp,
        scope,
        storage: 'on-demand' as const,
      }));
  }
  async enumerate(id: string, cursor?: string) {
    const caller = this.caller();
    return this.page(await this.adapter(id).enumerate(cursor, caller));
  }
  async query(id: string, request: Readonly<Record<string, unknown>>) {
    const caller = this.caller();
    return this.page(await this.adapter(id).query(structuredClone(request), caller));
  }
  async authorize(id: string, objects: readonly SourceObject[]) {
    const caller = this.caller();
    return this.adapter(id).authorize(objects, caller);
  }
  async read(id: string, object: SourceObject): Promise<SourceRead> {
    const caller = this.caller(),
      adapter = this.adapter(id);
    if (!(await adapter.authorize([object], caller)).includes(object.id))
      throw Error('Source read permission denied');
    const result = await adapter.read(object, caller);
    if (result.status === 'ok') {
      if (!result.object || result.object.id !== object.id || result.content === undefined)
        throw Error('Invalid source read response');
      // Never misrepresent a latest object as the immutable cited version.
      if (result.object.revision !== object.revision)
        return { status: 'version_unavailable', object: result.object };
    }
    return result;
  }
  private page(page: SourcePage) {
    if (
      !Array.isArray(page.items) ||
      (page.next !== undefined && typeof page.next !== 'string')
    )
      throw Error('Invalid source page');
    for (const o of page.items) {
      if (
        typeof o.id !== 'string' ||
        !o.id ||
        typeof o.revision !== 'string' ||
        !o.revision ||
        typeof o.kind !== 'string' ||
        !o.kind ||
        !o.locator ||
        typeof o.locator !== 'object' ||
        Array.isArray(o.locator)
      )
        throw Error('Source objects require stable identity, revision and locator');
    }
    return {
      items: page.items.map((o) =>
        structuredClone({
          id: o.id,
          locator: o.locator,
          revision: o.revision,
          kind: o.kind,
          ...(o.title !== undefined ? { title: o.title } : {}),
          ...(o.url !== undefined ? { url: o.url } : {}),
          ...(o.updatedAt !== undefined ? { updatedAt: o.updatedAt } : {}),
        }),
      ),
      ...(page.next ? { next: page.next } : {}),
    };
  }
  private adapter(id: string) {
    const adapter = this.adapters.get('profile', id)?.adapter;
    if (!adapter) throw Error(`Source unavailable: ${id}`);
    return adapter;
  }
  private caller(): PluginSessionQueryCaller {
    return Object.freeze({ invocation: this.agents.requireInvocation() });
  }
}
