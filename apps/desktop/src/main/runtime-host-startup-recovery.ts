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

import { RuntimeHostStartupError } from "@maka/runtime-host/client";

export type DesktopRuntimeHostStartupRepairResult =
  | { readonly kind: "repaired" }
  | { readonly kind: "active_tasks" }
  | { readonly kind: "unavailable" };

export interface DesktopRuntimeHostStartupRecoveryPrompt {
  readonly startupError: Error;
  readonly repairError?: Error;
  readonly activeTasks: boolean;
}

export interface DesktopRuntimeHostStartupRepairAuthority {
  readonly allowManualUpdate: boolean;
  readonly allowInterruptActiveTasks: boolean;
}

export class DesktopRuntimeHostStartupRecoveryCancelledError extends Error {
  readonly name = "DesktopRuntimeHostStartupRecoveryCancelledError";

  constructor(options?: ErrorOptions) {
    super("Runtime Host startup recovery was cancelled", options);
  }
}

export async function startDesktopRuntimeHostWithRecovery<T>(input: {
  readonly start: () => Promise<T>;
  readonly repair: (
    authority: DesktopRuntimeHostStartupRepairAuthority,
  ) => Promise<DesktopRuntimeHostStartupRepairResult>;
  readonly prompt: (
    input: DesktopRuntimeHostStartupRecoveryPrompt,
  ) => Promise<"repair" | "exit">;
}): Promise<T> {
  let startupError: Error;
  try {
    return await input.start();
  } catch (error) {
    startupError = asError(error);
    if (!canRepairManagedRuntimeHostStartup(startupError)) throw startupError;
  }

  let activeTasks = false;
  let repairError: Error | undefined;
  let automatic: DesktopRuntimeHostStartupRepairResult | undefined;
  try {
    automatic = await input.repair({
      allowManualUpdate: false,
      allowInterruptActiveTasks: false,
    });
  } catch (error) {
    repairError = asError(error);
  }
  if (automatic?.kind === "unavailable") throw startupError;
  if (automatic?.kind === "active_tasks") activeTasks = true;
  if (automatic?.kind === "repaired") {
    try {
      return await input.start();
    } catch (error) {
      startupError = asError(error);
      if (!canRepairManagedRuntimeHostStartup(startupError)) throw startupError;
    }
  }

  for (;;) {
    const decision = await input.prompt({
      startupError,
      ...(repairError ? { repairError } : {}),
      activeTasks,
    });
    if (decision === "exit") {
      throw new DesktopRuntimeHostStartupRecoveryCancelledError({
        cause: startupError,
      });
    }

    let repaired: DesktopRuntimeHostStartupRepairResult;
    try {
      repaired = await input.repair({
        allowManualUpdate: true,
        allowInterruptActiveTasks: activeTasks,
      });
    } catch (error) {
      repairError = asError(error);
      continue;
    }
    if (repaired.kind === "unavailable") throw startupError;
    if (repaired.kind === "active_tasks") {
      activeTasks = true;
      repairError = undefined;
      continue;
    }
    try {
      return await input.start();
    } catch (error) {
      startupError = asError(error);
      if (!canRepairManagedRuntimeHostStartup(startupError)) throw startupError;
      repairError = undefined;
    }
  }
}

export function canRepairManagedRuntimeHostStartup(error: Error): boolean {
  return (
    error instanceof RuntimeHostStartupError &&
    (error.reason === "managed_root_requires_operator" ||
      error.reason === "deployment_claim_mismatch" ||
      error.reason === "deployment_lifecycle_mismatch" ||
      error.reason === "deployment_launch_mismatch" ||
      error.reason === "deployment_transition_in_progress" ||
      error.reason === "deployment_needs_repair")
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
