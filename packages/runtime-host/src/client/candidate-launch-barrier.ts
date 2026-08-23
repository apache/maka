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
  ConnectOrSpawnRuntimeHostInput,
  ConnectOrSpawnRuntimeHostResult,
} from './connect-or-spawn.js';
import { connectOrSpawnRuntimeHostWithDependencies } from './connect-or-spawn.js';
import {
  launchOwnedRuntimeHostCandidate,
  type CandidateLauncher,
  type OwnedCandidateAttempt,
} from './launcher.js';

const DEFAULT_RETIRE_TIMEOUT_MS = 1_000;

export interface RuntimeHostCandidateLaunchBarrier {
  connect(input: ConnectOrSpawnRuntimeHostInput): Promise<ConnectOrSpawnRuntimeHostResult>;
  pause(): void;
  retireExcept(protectedPid: number): Promise<void>;
  resume(): void;
  release(): void;
}

export interface RuntimeHostCandidateLaunchBarrierDependencies {
  readonly launchCandidate: typeof launchOwnedRuntimeHostCandidate;
  readonly connect: (
    input: ConnectOrSpawnRuntimeHostInput,
    launchCandidate: CandidateLauncher,
  ) => Promise<ConnectOrSpawnRuntimeHostResult>;
  readonly retireTimeoutMs: number;
}

const defaultDependencies: RuntimeHostCandidateLaunchBarrierDependencies = {
  launchCandidate: launchOwnedRuntimeHostCandidate,
  connect: (input, launchCandidate) =>
    connectOrSpawnRuntimeHostWithDependencies(input, {
      launchCandidate,
      random: Math.random,
    }),
  retireTimeoutMs: DEFAULT_RETIRE_TIMEOUT_MS,
};

export function createRuntimeHostCandidateLaunchBarrier(): RuntimeHostCandidateLaunchBarrier {
  return createRuntimeHostCandidateLaunchBarrierWithDependencies(defaultDependencies);
}

export function createRuntimeHostCandidateLaunchBarrierWithDependencies(
  dependencies: RuntimeHostCandidateLaunchBarrierDependencies,
): RuntimeHostCandidateLaunchBarrier {
  return new RuntimeHostCandidateLaunchBarrierImpl(dependencies);
}

class RuntimeHostCandidateLaunchBarrierImpl implements RuntimeHostCandidateLaunchBarrier {
  readonly #attempts = new Set<OwnedCandidateAttempt>();
  readonly #pending = new Set<Promise<OwnedCandidateAttempt>>();
  #state: 'active' | 'paused' | 'released' = 'active';

  constructor(private readonly dependencies: RuntimeHostCandidateLaunchBarrierDependencies) {}

  connect(input: ConnectOrSpawnRuntimeHostInput): Promise<ConnectOrSpawnRuntimeHostResult> {
    if (this.#state !== 'active') {
      return Promise.reject(new Error('Runtime Host candidate launches are paused'));
    }
    return this.dependencies.connect(input, (candidate) => this.#launch(candidate));
  }

  pause(): void {
    if (this.#state !== 'active') {
      throw new Error('Runtime Host candidate launch barrier is not active');
    }
    this.#state = 'paused';
  }

  async retireExcept(protectedPid: number): Promise<void> {
    if (this.#state !== 'paused') {
      throw new Error('Runtime Host candidate launches must be paused before retirement');
    }
    await Promise.allSettled([...this.#pending]);
    const retiring = [...this.#attempts].filter((attempt) => attempt.pid !== protectedPid);
    await Promise.all(
      retiring.map(async (attempt) => {
        await attempt.settle(this.dependencies.retireTimeoutMs);
        this.#attempts.delete(attempt);
      }),
    );
  }

  resume(): void {
    if (this.#state === 'paused') this.#state = 'active';
  }

  release(): void {
    if (this.#state === 'released') return;
    this.#state = 'released';
    for (const attempt of this.#attempts) attempt.releaseToEnvironment();
    this.#attempts.clear();
  }

  #launch(input: Parameters<CandidateLauncher>[0]): ReturnType<CandidateLauncher> {
    if (this.#state !== 'active') {
      throw new Error('Runtime Host candidate launches are paused');
    }
    const launch = this.dependencies.launchCandidate(input);
    const pending = launch.spawned;
    this.#pending.add(pending);
    void pending.then(
      (attempt) => {
        this.#pending.delete(pending);
        if (this.#state === 'released') {
          attempt.releaseToEnvironment();
          return;
        }
        this.#attempts.add(attempt);
        void attempt.startupFailure?.finally(() => this.#attempts.delete(attempt));
      },
      () => this.#pending.delete(pending),
    );
    return launch;
  }
}
