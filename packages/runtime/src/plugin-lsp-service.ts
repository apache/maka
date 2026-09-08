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
    readonly lsp: PluginLspService;
  }
}

export type PluginLspOperation = 'definition' | 'references' | 'implementation' | 'hover';
export interface PluginLspPosition {
  readonly line: number;
  readonly character: number;
}
export interface PluginLspRequest {
  readonly sessionId: string;
  readonly filePath: string;
  readonly position: PluginLspPosition;
  readonly operation: PluginLspOperation;
}
export interface PluginLspProvider {
  readonly id: string;
  readonly extensionToLanguage: Readonly<Record<string, string>>;
  query(
    request: PluginLspRequest & { readonly languageId: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}
interface RegisteredRoute extends MakaContributionIdentity {
  readonly provider: PluginLspProvider;
  readonly languageId: string;
  readonly token: symbol;
  retired: boolean;
}

/** High-level LSP router; providers own processes, callers receive no JSON-RPC escape hatch. */
export class PluginLspService extends Service {
  private readonly routes = new PluginScopeRegistry<RegisteredRoute>();
  constructor(ctx: Context) {
    super(ctx, 'lsp');
  }

  registerProvider(provider: PluginLspProvider): () => Promise<void> {
    validateProvider(provider);
    const identity = pluginIdentity(this.ctx);
    if (identity.scopeId === 'desktop-ui')
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'desktop-ui plugins cannot register Host LSP providers',
      );
    return registerPluginContribution(
      this.ctx,
      `lsp.registerProvider(${JSON.stringify(provider.id)})`,
      () => {
        const rootId = identity.scopeId as MakaPluginRootId;
        const pending = Object.entries(provider.extensionToLanguage).map(
          ([extension, languageId]) => [normalizeExtension(extension), languageId] as const,
        );
        for (const [extension] of pending) {
          const existing = this.routes.get(rootId, extension);
          if (existing && existing.entryId !== identity.entryId)
            throw new MakaPluginRuntimeError(
              'activation_failed',
              `LSP extension ${JSON.stringify(extension)} is already registered by ${existing.entryId}`,
            );
        }
        const disposers = pending.map(([extension, languageId]) =>
          this.routes.publish(rootId, extension, {
            ...identity,
            provider,
            languageId,
            token: Symbol(`${provider.id}:${extension}`),
            retired: false,
          }),
        );
        return async () => {
          await Promise.all(disposers.reverse().map((dispose) => dispose()));
        };
      },
    );
  }

  async query(request: PluginLspRequest, signal?: AbortSignal): Promise<unknown> {
    validateRequest(request);
    const route = this.routes.visible(request.sessionId).get(finalExtension(request.filePath));
    if (!route) throw new Error(`No LSP provider handles ${JSON.stringify(request.filePath)}`);
    if (signal?.aborted) throw signal.reason ?? new Error('LSP query aborted');
    return await route.provider.query(
      Object.freeze({ ...request, languageId: route.languageId }),
      signal,
    );
  }
}

export function finalExtension(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}
function normalizeExtension(value: string): string {
  const extension = value.toLowerCase();
  const result = extension.startsWith('.') ? extension : `.${extension}`;
  if (!/^\.[^./\\]+$/u.test(result)) throw new TypeError(`Invalid LSP extension: ${value}`);
  return result;
}
function validateProvider(provider: PluginLspProvider): void {
  if (
    !provider.id.trim() ||
    typeof provider.query !== 'function' ||
    Object.keys(provider.extensionToLanguage).length === 0
  )
    throw new TypeError('Invalid LSP provider');
  for (const [extension, language] of Object.entries(provider.extensionToLanguage)) {
    normalizeExtension(extension);
    if (!language.trim()) throw new TypeError('LSP language id must not be empty');
  }
}
function validateRequest(request: PluginLspRequest): void {
  if (
    !request.sessionId ||
    !request.filePath ||
    !Number.isSafeInteger(request.position.line) ||
    request.position.line < 0 ||
    !Number.isSafeInteger(request.position.character) ||
    request.position.character < 0
  )
    throw new TypeError('Invalid LSP query');
}
