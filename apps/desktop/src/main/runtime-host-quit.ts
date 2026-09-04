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
  DesktopLocalHostRetirementError,
  type RuntimeHostDesktopManager,
} from './runtime-host-desktop-manager.js';

type RetirementOwner = Pick<
  RuntimeHostDesktopManager,
  'retireOwnedLocalHost' | 'forceTerminateOwnedLocalHost'
>;

export type RuntimeHostQuitFailureDecision = 'retry' | 'force' | 'cancel';

export interface RuntimeHostQuitPrompts {
  confirmInterrupt(): Promise<boolean>;
  recoverFailure(error: unknown): Promise<RuntimeHostQuitFailureDecision>;
}

export async function prepareRuntimeHostQuit(
  owner: RetirementOwner | undefined,
  prompts: RuntimeHostQuitPrompts,
): Promise<'ready' | 'cancelled'> {
  if (!owner) return 'ready';
  for (;;) {
    try {
      const guarded = await owner.retireOwnedLocalHost('refuse_active_work');
      if (guarded.kind !== 'active_tasks') return 'ready';
      if (!(await prompts.confirmInterrupt())) return 'cancelled';
      const authorized = await owner.retireOwnedLocalHost('interrupt_active_work');
      if (authorized.kind === 'active_tasks') {
        throw new Error('Runtime Host refused authorized quit retirement');
      }
      return 'ready';
    } catch (error) {
      const recovery = await recoverRuntimeHostQuit(owner, prompts, error);
      if (recovery !== 'retry') return recovery;
    }
  }
}

async function recoverRuntimeHostQuit(
  owner: RetirementOwner,
  prompts: RuntimeHostQuitPrompts,
  error: unknown,
): Promise<'ready' | 'retry' | 'cancelled'> {
  let currentError = error;
  for (;;) {
    const retirement = forceTerminableRetirement(currentError);
    const decision = await prompts.recoverFailure(currentError);
    if (decision === 'cancel') return 'cancelled';
    if (decision === 'retry') return 'retry';
    if (!retirement) throw new Error('Force termination was selected without Host authority');
    try {
      if (await owner.forceTerminateOwnedLocalHost(retirement.facts)) return 'ready';
      currentError = forceTerminationError(
        retirement,
        new Error('The Runtime Host identity changed or forced termination failed'),
      );
    } catch (cause) {
      currentError = forceTerminationError(retirement, cause);
    }
  }
}

function forceTerminableRetirement(
  error: unknown,
): DesktopLocalHostRetirementError | undefined {
  return error instanceof DesktopLocalHostRetirementError &&
    error.facts.pid !== undefined &&
    error.facts.forceTerminationAvailable
    ? error
    : undefined;
}

function forceTerminationError(
  retirement: DesktopLocalHostRetirementError,
  cause: unknown,
): DesktopLocalHostRetirementError {
  return new DesktopLocalHostRetirementError(
    { ...retirement.facts, forceTerminationAvailable: false },
    { cause: cause instanceof Error ? cause : new Error(String(cause)) },
  );
}
