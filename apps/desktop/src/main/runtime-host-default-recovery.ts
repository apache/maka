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

import { LOCAL_RUNTIME_HOST_PROFILE } from '@maka/runtime-host/client';

export type RuntimeHostDefaultRecoveryDecision =
  | 'retry'
  | 'use_local'
  | 'keep_offline';

export interface RuntimeHostDefaultFailure {
  readonly profileId: string;
  readonly profileName: string;
  readonly error: Error;
}

/** Coordinates the one recovery choice that belongs to the default Host. */
export function createRuntimeHostDefaultRecovery(input: {
  readonly defaultProfileId: () => string;
  readonly prompt: (
    failure: RuntimeHostDefaultFailure,
  ) => Promise<RuntimeHostDefaultRecoveryDecision>;
  readonly retry: (profileId: string) => Promise<Error | undefined>;
  readonly useLocal: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}): {
  offer(failure: RuntimeHostDefaultFailure): void;
} {
  let pending: Promise<void> | undefined;

  const recover = async (initialFailure: RuntimeHostDefaultFailure): Promise<void> => {
    let failure = initialFailure;
    while (input.defaultProfileId() === failure.profileId) {
      const decision = await input.prompt(failure);
      if (input.defaultProfileId() !== failure.profileId) return;
      if (decision === 'keep_offline') return;
      if (decision === 'use_local') {
        await input.useLocal();
        return;
      }
      const retryFailure = await input.retry(failure.profileId);
      if (!retryFailure) return;
      failure = { ...failure, error: retryFailure };
    }
  };

  return {
    offer(failure) {
      if (
        failure.profileId === LOCAL_RUNTIME_HOST_PROFILE.id ||
        input.defaultProfileId() !== failure.profileId ||
        pending
      ) return;
      pending = recover(failure)
        .catch(input.onError)
        .finally(() => {
          pending = undefined;
        });
    },
  };
}
