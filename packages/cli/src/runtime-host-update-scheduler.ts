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

import { join } from 'node:path';
import {
  RUNTIME_HOST_UPDATE_CHECK_INTERVAL_HOURS_MAX,
  RUNTIME_HOST_UPDATE_CHECK_INTERVAL_HOURS_MIN,
} from '@maka/runtime-host/operator';
import {
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostServiceBackend,
  type RuntimeHostServiceDeployment,
} from './runtime-host-service-manager.js';

export interface RuntimeHostUpdateSchedulerBackend {
  install(config: RuntimeHostManagedServiceConfig): Promise<RuntimeHostServiceDeployment>;
  verifyDeployment(config: RuntimeHostManagedServiceConfig): Promise<void>;
  logs(): Promise<string>;
  uninstall(): Promise<void>;
}

export function withRuntimeHostUpdateScheduler(
  service: RuntimeHostServiceBackend,
  scheduler: RuntimeHostUpdateSchedulerBackend,
): RuntimeHostServiceBackend {
  return {
    preflightInstall: () => service.preflightInstall(),
    install: async (config) => {
      const serviceDeployment = await service.install(config);
      let schedulerDeployment: RuntimeHostServiceDeployment;
      try {
        schedulerDeployment = await scheduler.install(config);
      } catch (error) {
        await rollbackAfterFailure(serviceDeployment, error);
      }
      return {
        rollback: async () => {
          const failures: unknown[] = [];
          await schedulerDeployment.rollback().catch((error) => failures.push(error));
          await serviceDeployment.rollback().catch((error) => failures.push(error));
          if (failures.length > 0) {
            throw new RuntimeHostServiceManagerError(
              'service_manager_operation_failed',
              'Rolling back the Runtime Host service and update schedule failed',
              { cause: new AggregateError(failures) },
            );
          }
        },
      };
    },
    replace: (config) => service.replace(config),
    verifyDeployment: async (config) => {
      await Promise.all([service.verifyDeployment(config), scheduler.verifyDeployment(config)]);
    },
    status: () => service.status(),
    start: () => service.start(),
    stop: () => service.stop(),
    restart: () => service.restart(),
    logs: async () => {
      const serviceLogs = await service.logs();
      const schedulerLogs = await scheduler
        .logs()
        .catch(
          (error: unknown) =>
            `unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      return [serviceLogs, schedulerLogs && `update scheduler:\n${schedulerLogs}`]
        .filter(Boolean)
        .join('\n');
    },
    uninstall: async () => {
      await scheduler.uninstall();
      await service.uninstall();
    },
  };
}

export function runtimeHostUpdateSchedulerArguments(
  config: RuntimeHostManagedServiceConfig,
): readonly string[] | null {
  if (!config.managedDeploymentRoot) return null;
  return [
    join(config.managedDeploymentRoot, 'operator'),
    'reconcile-update',
    '--scheduled',
    '--json',
  ];
}

export function runtimeHostUpdateSchedule(serviceId: string): { readonly minute: number } {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  return { minute: Number.parseInt(serviceId.slice(0, 2), 16) % 60 };
}

export function isRuntimeHostScheduledUpdateDue(
  serviceId: string,
  checkIntervalHours: number,
  now: number,
): boolean {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  if (
    !Number.isSafeInteger(checkIntervalHours) ||
    checkIntervalHours < RUNTIME_HOST_UPDATE_CHECK_INTERVAL_HOURS_MIN ||
    checkIntervalHours > RUNTIME_HOST_UPDATE_CHECK_INTERVAL_HOURS_MAX
  ) {
    throw new TypeError('Invalid Runtime Host update check interval');
  }
  const phase = Number.parseInt(serviceId.slice(2, 10), 16) % checkIntervalHours;
  return Math.floor(now / (60 * 60 * 1_000)) % checkIntervalHours === phase;
}

async function rollbackAfterFailure(
  deployment: RuntimeHostServiceDeployment,
  originalError: unknown,
): Promise<never> {
  try {
    await deployment.rollback();
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Installing the Runtime Host update schedule failed and the service could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  throw originalError;
}
