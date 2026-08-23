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
  LOCAL_RUNTIME_HOST_PROFILE,
  createClientRuntimeHostProfileCatalog,
  type RuntimeHostRemoteTransport,
  type RuntimeHostProfileCatalog,
} from '@maka/runtime-host/client';
import { resolveMakaClientDataRoot } from '@maka/storage';

const DEFAULT_CREDENTIAL_ENV = 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL';

export type RuntimeHostProfileCommand =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'set';
      readonly id: string;
      readonly name: string;
      readonly transport: RuntimeHostRemoteTransport;
      readonly expectedRootId: string;
      readonly credentialEnv?: string;
    }
  | { readonly kind: 'remove'; readonly id: string };

export interface RuntimeHostProfileCommandDeps {
  readonly catalog: RuntimeHostProfileCatalog;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (value: string) => void;
}

export interface RuntimeHostProfileCommandOptions {
  readonly clientDataRoot: string;
}

export async function runRuntimeHostProfileCommand(
  command: RuntimeHostProfileCommand,
  overrides: Partial<RuntimeHostProfileCommandDeps> = {},
  options: RuntimeHostProfileCommandOptions = { clientDataRoot: resolveMakaClientDataRoot() },
): Promise<number> {
  const deps = { ...defaultDeps(options.clientDataRoot), ...overrides };
  if (command.kind === 'list') {
    const document = await deps.catalog.read();
    deps.write(`${JSON.stringify([LOCAL_RUNTIME_HOST_PROFILE, ...document.profiles], null, 2)}\n`);
    return 0;
  }
  if (command.kind === 'remove') {
    await deps.catalog.remove(command.id);
    return 0;
  }

  const credentialEnv = command.credentialEnv ?? DEFAULT_CREDENTIAL_ENV;
  const suppliedCredential = deps.env[credentialEnv];
  const document = await deps.catalog.save(
    {
      id: command.id,
      name: command.name,
      kind: 'remote',
      transport: command.transport,
      rootId: command.expectedRootId,
    },
    suppliedCredential,
  );
  const profile = document.profiles.find((candidate) => candidate.id === command.id);
  if (!profile) throw new Error('Runtime Host profile update did not persist');
  deps.write(`${JSON.stringify(profile, null, 2)}\n`);
  return 0;
}

function defaultDeps(clientDataRoot: string): RuntimeHostProfileCommandDeps {
  return {
    catalog: createClientRuntimeHostProfileCatalog(clientDataRoot),
    env: process.env,
    write: (value) => process.stdout.write(value),
  };
}
