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

import type { ResourceAuthority } from './types.js';

export type RegisteredToolAuthority = ResourceAuthority<unknown, unknown>;
export type ToolAuthorityRegistration = readonly [
  toolId: string,
  authority: RegisteredToolAuthority,
];

/**
 * The process-owned, immutable authority registry. A canonical tool id may be
 * registered exactly once; duplicate registrations fail during composition
 * instead of silently changing resource semantics for later backends.
 */
export class ToolAuthorityRegistry {
  readonly #authorities: ReadonlyMap<string, RegisteredToolAuthority>;

  constructor(registrations: Iterable<ToolAuthorityRegistration> = []) {
    const authorities = new Map<string, RegisteredToolAuthority>();
    for (const [toolId, authority] of registrations) {
      if (toolId.length === 0 || toolId.trim() !== toolId) {
        throw new Error(
          `Tool authority id must be a non-empty canonical id: ${JSON.stringify(toolId)}`,
        );
      }
      if (authorities.has(toolId)) {
        throw new Error(`Tool authority is already registered: ${toolId}`);
      }
      authorities.set(toolId, authority);
    }
    this.#authorities = authorities;
  }

  resolve(toolId: string): RegisteredToolAuthority | undefined {
    return this.#authorities.get(toolId);
  }

  has(toolId: string): boolean {
    return this.#authorities.has(toolId);
  }

  /**
   * Return a new immutable registry containing the current registrations plus
   * the supplied registrations. The constructor remains the single duplicate
   * check, so a policy cannot silently replace a domain authority.
   */
  withRegistrations(registrations: Iterable<ToolAuthorityRegistration>): ToolAuthorityRegistry {
    return new ToolAuthorityRegistry([...this.#authorities, ...registrations]);
  }

  get size(): number {
    return this.#authorities.size;
  }
}
