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

import { cleanup, signal } from 'nsh';
import type { ServiceMethods } from '../../../../../../packages/plugin-sdk/src/generated/methods';
import type {
  CredentialStatus,
  CredentialVersionBasis,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { hostMutate, hostQuery, type MutationProgress } from '../../bridge';

const service = {
  settingsAuthentication: 'authentication',
  settingsSetup: 'setup',
  deploymentManager: 'management',
  workspaceWeb: 'web',
} as const;
type Endpoint = keyof ServiceMethods;
type Method<E extends Endpoint, Mode extends string> = {
  [M in keyof ServiceMethods[E]]: ServiceMethods[E][M] extends { mode: Mode } ? M : never;
}[keyof ServiceMethods[E]] &
  string;
type Input<E extends Endpoint, M extends keyof ServiceMethods[E]> = ServiceMethods[E][M] extends {
  input: infer I;
}
  ? I
  : never;
type Output<E extends Endpoint, M extends keyof ServiceMethods[E]> = ServiceMethods[E][M] extends {
  output: infer O;
}
  ? O
  : never;

export function settingsRpc(rootId: string) {
  const endpoint = (name: Endpoint) => service[name as keyof typeof service] ?? name;
  return {
    query<E extends Endpoint, M extends Method<E, 'query'>>(
      name: E,
      method: M,
      input: Input<E, M>,
    ) {
      return hostQuery<Output<E, M>>(
        endpoint(name),
        method,
        input as Record<string, unknown>,
        undefined,
        rootId,
      );
    },
    mutate<E extends Endpoint, M extends Method<E, 'mutation'>>(
      name: E,
      method: M,
      input: Input<E, M>,
      options?: { secret?: string; onProgress?: (progress: MutationProgress) => void },
    ) {
      return hostMutate<Output<E, M>>(endpoint(name), method, input as Record<string, unknown>, {
        rootId,
        ...options,
      });
    },
  };
}

export type SettingsRpc = ReturnType<typeof settingsRpc>;

export function credentialBasis(status: CredentialStatus | null): CredentialVersionBasis | null {
  if (!status?.configured || status.credentialId === null || status.revision === null) return null;
  return { locator: status.locator, credentialId: status.credentialId, revision: status.revision };
}

export function settingsWork() {
  const busy = signal(false);
  const error = signal('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  async function run(work: () => Promise<void>, safeError?: string) {
    if (!alive || busy()) return;
    busy.set(true);
    error.set('');
    try {
      await work();
    } catch (cause) {
      if (alive) error.set(safeError ?? (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      if (alive) busy.set(false);
    }
  }

  return { busy, error, run, alive: () => alive };
}

export type SettingsWork = ReturnType<typeof settingsWork>;
