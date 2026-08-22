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

import type { DesktopRuntimeHostRef } from '../preload/bridge-contract.js';

export type DefaultRuntimeHostDiagnosticTarget = { readonly profileId: string };

class DefaultRuntimeHostOperationError extends Error {
  readonly diagnosticTarget: DefaultRuntimeHostDiagnosticTarget;

  constructor(cause: unknown, diagnosticTarget: DefaultRuntimeHostDiagnosticTarget) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
    this.diagnosticTarget = diagnosticTarget;
  }
}

export async function runOnDefaultRuntimeHost<T>(
  operation: (host: DesktopRuntimeHostRef) => Promise<T>,
): Promise<{
  readonly value: T;
  readonly host: DesktopRuntimeHostRef;
  readonly diagnosticTarget: DefaultRuntimeHostDiagnosticTarget;
}> {
  const host = await window.maka.runtimeHostProfiles.getDefaultHost();
  const diagnosticTarget = { profileId: host.profileId };
  try {
    return { value: await operation(host), host, diagnosticTarget };
  } catch (error) {
    throw new DefaultRuntimeHostOperationError(error, diagnosticTarget);
  }
}

export async function runIfDefaultRuntimeHostCurrent(
  host: DesktopRuntimeHostRef,
  operation: () => unknown | Promise<unknown>,
): Promise<boolean> {
  let currentHost: DesktopRuntimeHostRef;
  try {
    currentHost = await window.maka.runtimeHostProfiles.getDefaultHost();
  } catch {
    return false;
  }
  if (currentHost.profileId !== host.profileId || currentHost.hostId !== host.hostId) {
    return false;
  }
  await operation();
  return true;
}

export function defaultRuntimeHostDiagnosticTarget(
  error: unknown,
): DefaultRuntimeHostDiagnosticTarget | undefined {
  return error instanceof DefaultRuntimeHostOperationError
    ? error.diagnosticTarget
    : undefined;
}
