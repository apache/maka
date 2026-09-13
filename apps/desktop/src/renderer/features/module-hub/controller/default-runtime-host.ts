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

import type {
  ModuleHubRuntimeHostRef,
  ModuleHubRuntimeHostsService,
} from '../ports.js';

export type ModuleHubDiagnosticTarget = { readonly profileId: string };

class ModuleHubDefaultRuntimeHostOperationError extends Error {
  readonly diagnosticTarget: ModuleHubDiagnosticTarget;
  readonly host: ModuleHubRuntimeHostRef;

  constructor(
    cause: unknown,
    host: ModuleHubRuntimeHostRef,
    diagnosticTarget: ModuleHubDiagnosticTarget,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
    this.host = host;
    this.diagnosticTarget = diagnosticTarget;
  }
}

export async function runOnDefaultRuntimeHost<T>(
  runtimeHosts: ModuleHubRuntimeHostsService,
  operation: (host: ModuleHubRuntimeHostRef) => Promise<T>,
): Promise<{
  readonly value: T;
  readonly host: ModuleHubRuntimeHostRef;
  readonly diagnosticTarget: ModuleHubDiagnosticTarget;
}> {
  const host = await runtimeHosts.getDefault();
  const diagnosticTarget = { profileId: host.profileId };
  try {
    return { value: await operation(host), host, diagnosticTarget };
  } catch (error) {
    throw new ModuleHubDefaultRuntimeHostOperationError(
      error,
      host,
      diagnosticTarget,
    );
  }
}

export async function isDefaultRuntimeHostCurrent(
  runtimeHosts: ModuleHubRuntimeHostsService,
  host: ModuleHubRuntimeHostRef,
): Promise<boolean> {
  try {
    const currentHost = await runtimeHosts.getDefault();
    return (
      currentHost.profileId === host.profileId &&
      currentHost.hostId === host.hostId
    );
  } catch {
    return false;
  }
}

export async function runIfDefaultRuntimeHostCurrent(
  runtimeHosts: ModuleHubRuntimeHostsService,
  host: ModuleHubRuntimeHostRef,
  operation: () => unknown | Promise<unknown>,
): Promise<boolean> {
  if (!(await isDefaultRuntimeHostCurrent(runtimeHosts, host))) return false;
  await operation();
  return true;
}

export function defaultRuntimeHostDiagnosticTarget(
  error: unknown,
): ModuleHubDiagnosticTarget | undefined {
  return error instanceof ModuleHubDefaultRuntimeHostOperationError
    ? error.diagnosticTarget
    : undefined;
}

export function defaultRuntimeHostOperationHost(
  error: unknown,
): ModuleHubRuntimeHostRef | undefined {
  return error instanceof ModuleHubDefaultRuntimeHostOperationError
    ? error.host
    : undefined;
}
