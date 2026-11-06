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
  InteractionRecord,
  SystemPermissionGrant,
} from '../../../../packages/plugin-sdk/src/generated/runtime';

export type ComputerPermissionStatus = {
  record: InteractionRecord;
  grants: Array<{ grant: SystemPermissionGrant; effective: boolean }>;
  requestable: boolean;
};
export type ComputerPermissionClient = {
  status(): Promise<ComputerPermissionStatus>;
  actions(): Promise<string[]>;
  request(grant: SystemPermissionGrant): Promise<ComputerPermissionStatus>;
  action(action: string): Promise<void>;
  cancel(): Promise<void>;
};
export type PermissionSetupState = {
  status: ComputerPermissionStatus | null;
  actions: string[];
  operation: 'loading' | 'idle' | 'requesting' | 'opening' | 'cancelling';
  active: SystemPermissionGrant | null;
  attempted: SystemPermissionGrant[];
  error: unknown | null;
};
export const nextPermission = (status: ComputerPermissionStatus | null) => {
  if (!status || status.record.outcome || status.record.request.kind !== 'system_permission')
    return null;
  return (
    status.record.request.grants.find(
      (grant) => !status.grants.some((observed) => observed.grant === grant && observed.effective),
    ) ?? null
  );
};

/** Owns one request's observation, never an OS permission decision. Dispose stops observation, not the Host call. */
export function createComputerPermissionSetup(
  client: ComputerPermissionClient,
  changed: (state: PermissionSetupState) => void,
  schedule: (tick: () => void, milliseconds: number) => () => void = (tick, milliseconds) => {
    const timer = setTimeout(tick, milliseconds);
    return () => clearTimeout(timer);
  },
) {
  let state: PermissionSetupState = {
    status: null,
    actions: [],
    operation: 'loading',
    active: null,
    attempted: [],
    error: null,
  };
  let alive = true;
  let reading = false;
  let generation = 0;
  let cancelRequested = false;
  let observationError: unknown = null;
  let stop = () => {};
  const update = (patch: Partial<PermissionSetupState>) => {
    if (!alive) return;
    state = { ...state, ...patch };
    changed(state);
  };
  const pending = () => alive && !state.status?.record.outcome;
  const accept = (status: ComputerPermissionStatus) => {
    // A completed receipt wins over an older in-flight observation or TCC reply.
    if (!pending()) return;
    update({ status });
    if (status.record.outcome) stop();
  };
  const poll = () => {
    stop();
    if (pending()) stop = schedule(() => void refresh(), 1500);
  };
  const refresh = async () => {
    if (!pending() || reading) return;
    reading = true;
    const version = generation;
    try {
      const [status, actions] = await Promise.all([client.status(), client.actions()]);
      if (alive && version === generation) {
        accept(status);
        update({ actions, ...(state.error === observationError ? { error: null } : {}) });
        observationError = null;
      }
    } catch (error) {
      if (alive && version === generation) {
        observationError = error;
        update({ error });
      }
    } finally {
      reading = false;
      if (alive && state.operation === 'loading')
        update({ operation: cancelRequested ? 'cancelling' : 'idle' });
      poll();
    }
  };
  const enable = async (grant: SystemPermissionGrant) => {
    if (
      !pending() ||
      state.operation !== 'idle' ||
      !state.status?.requestable ||
      nextPermission(state.status) !== grant ||
      cancelRequested
    )
      return;
    if (state.attempted.includes(grant)) {
      await open(grant);
      return;
    }
    generation++;
    update({
      operation: 'requesting',
      active: grant,
      attempted: [...state.attempted, grant],
      error: null,
    });
    try {
      const status = await client.request(grant);
      accept(status);
      if (!pending() || cancelRequested) return;
      if (
        !status.grants.some((entry) => entry.grant === grant && entry.effective) &&
        state.actions.includes(grant)
      ) {
        update({ operation: 'opening' });
        await client.action(grant);
      }
    } catch (error) {
      if (pending()) update({ error });
    } finally {
      generation++;
      update({ operation: cancelRequested ? 'cancelling' : 'idle' });
      poll();
    }
  };
  const open = async (action: string) => {
    if (
      !pending() ||
      state.operation !== 'idle' ||
      !state.actions.includes(action) ||
      cancelRequested
    )
      return;
    update({ operation: 'opening', error: null });
    try {
      await client.action(action);
    } catch (error) {
      if (pending()) update({ error });
    } finally {
      update({ operation: cancelRequested ? 'cancelling' : 'idle' });
    }
  };
  const cancel = async () => {
    if (!pending() || cancelRequested) return;
    cancelRequested = true;
    update({ operation: 'cancelling', error: null });
    try {
      await client.cancel();
    } catch (error) {
      if (pending()) update({ error });
    } finally {
      // Never resend an uncertain cancellation; the original receipt/status remains authoritative.
      if (pending()) await refresh();
    }
  };
  return {
    refresh,
    enable,
    open,
    cancel,
    snapshot: () => state,
    dispose() {
      alive = false;
      stop();
    },
  };
}
