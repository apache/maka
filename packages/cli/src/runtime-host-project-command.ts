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
  connectExistingRuntimeHost,
  readRuntimeHostProjectDetails,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import { resolve } from 'node:path';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export type RuntimeHostProjectCommand =
  | { readonly kind: 'list'; readonly rootPath: string }
  | { readonly kind: 'add'; readonly rootPath: string; readonly path: string };

interface RuntimeHostProjectCommandDeps {
  readonly connect: (rootPath: string) => Promise<RuntimeHostConnection>;
  readonly write: (value: string) => void;
}

export async function runRuntimeHostProjectCli(
  command: RuntimeHostProjectCommand,
  overrides: Partial<RuntimeHostProjectCommandDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const connection = await deps.connect(command.rootPath);
  try {
    const result =
      command.kind === 'list'
        ? await readRuntimeHostProjectDetails(connection)
        : await connection.request('project.catalog.mutate', {
            kind: 'register',
            path: resolve(command.path),
          });
    deps.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}

function defaultDeps(): RuntimeHostProjectCommandDeps {
  return {
    connect: connectLocalOwner,
    write: (value) => process.stdout.write(value),
  };
}

async function connectLocalOwner(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectExistingRuntimeHost({
    rootPath,
    protocol: PROTOCOL,
  });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host service is not available (${result.kind})`);
  }
  return result.connection;
}
