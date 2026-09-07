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
  RuntimeHostReconciliationProvider,
  RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import { isAbsolute } from 'node:path';

export type RuntimeHostSupervisorState =
  | 'not_installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'failed';

/** A provider receives an exact command, not Host lifecycle configuration. */
export interface RuntimeHostProviderDefinition {
  readonly command: readonly [string, ...string[]];
}

export interface RuntimeHostSupervisorStatus {
  readonly provider: RuntimeHostSupervisorProvider;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: RuntimeHostSupervisorState;
  /** The supervised Runtime Host/State Root owner, never an intermediate launcher. */
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

/** Owns only the OS artifact and process supervision for one Runtime Host. */
export interface RuntimeHostSupervisor {
  readonly provider: RuntimeHostSupervisorProvider;
  preflight(): Promise<void>;
  converge(definition: RuntimeHostProviderDefinition): Promise<void>;
  verify(definition: RuntimeHostProviderDefinition): Promise<void>;
  status(): Promise<RuntimeHostSupervisorStatus>;
  activate(): Promise<void>;
  retire(): Promise<void>;
  logs(): Promise<string>;
  uninstall(): Promise<void>;
}

/** Owns only the OS artifact that invokes the one-shot reconciler. */
export interface RuntimeHostReconciliationTrigger {
  readonly provider: RuntimeHostReconciliationProvider;
  converge(definition: RuntimeHostProviderDefinition): Promise<void>;
  verify(definition: RuntimeHostProviderDefinition): Promise<void>;
  status(): Promise<{ readonly installed: boolean; readonly active: boolean }>;
  activate(): Promise<void>;
  logs(): Promise<string>;
  uninstall(): Promise<void>;
}

export interface RuntimeHostLifecycleProvider {
  readonly supervisor: RuntimeHostSupervisor;
  readonly reconciliationTrigger: RuntimeHostReconciliationTrigger;
}

export type RuntimeHostSupervisedAvailability = 'session' | 'environment' | 'machine';

/** A provider selected during installation together with the availability it can actually offer. */
export interface RuntimeHostLifecycleProviderOffer {
  readonly provider: RuntimeHostLifecycleProvider;
  readonly availability: RuntimeHostSupervisedAvailability;
}

export function assertRuntimeHostProviderDefinition(value: RuntimeHostProviderDefinition): void {
  if (
    value.command.length === 0 ||
    value.command.length > 64 ||
    !isAbsolute(value.command[0]) ||
    value.command.some(
      (argument) =>
        argument.length === 0 ||
        Buffer.byteLength(argument, 'utf8') > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(argument),
    )
  ) {
    throw new TypeError('Runtime Host provider command is invalid');
  }
}
