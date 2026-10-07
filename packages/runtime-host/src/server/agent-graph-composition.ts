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

import { AgentGraphSupervisorWakeCoordinator } from '@maka/runtime/agent-graph-supervisor-wake';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { AgentGraphCoordinator } from '@maka/runtime/stream-graph-coordinator';
import type { ExecutionGraphStore } from '@maka/storage/execution-persistence-provider';
import { HostAgentGraphCoordinator } from './agent-graph-coordinator.js';

/** Staged owner for the graph authorities whose bindings follow Host startup order. */
export class RuntimeHostAgentGraphComposition {
  readonly controlStore: ExecutionGraphStore;
  readonly activityRegistry = new SessionActivityRegistry();
  #coordinator: AgentGraphCoordinator | undefined;
  #client: HostAgentGraphCoordinator | undefined;
  #supervisorWake: AgentGraphSupervisorWakeCoordinator | undefined;
  // Keep each authority visible to the module's lifecycle error collector.
  readonly drainHooks = [
    () => this.#supervisorWake?.beginDrain(),
    () => this.#coordinator?.beginDrain(),
  ];
  readonly closeHooks = [
    () => this.#supervisorWake?.close(),
    () => this.#client?.close(),
    () => this.#coordinator?.close(),
    () => this.controlStore.close(),
  ];

  constructor(controlStore: ExecutionGraphStore) {
    this.controlStore = controlStore;
  }

  get coordinator(): AgentGraphCoordinator {
    if (!this.#coordinator) throw new Error('Runtime Host Agent Graph coordinator is not composed');
    return this.#coordinator;
  }

  get client(): HostAgentGraphCoordinator {
    if (!this.#client) throw new Error('Runtime Host Agent Graph client is not composed');
    return this.#client;
  }

  get supervisorWake(): AgentGraphSupervisorWakeCoordinator {
    if (!this.#supervisorWake) {
      throw new Error('Runtime Host Agent Graph supervisor wake coordinator is not composed');
    }
    return this.#supervisorWake;
  }

  bindCoordinator(coordinator: AgentGraphCoordinator): void {
    if (this.#coordinator) throw new Error('Runtime Host Agent Graph coordinator is already bound');
    this.#coordinator = coordinator;
  }

  bindClient(client: HostAgentGraphCoordinator): void {
    if (this.#client) throw new Error('Runtime Host Agent Graph client is already bound');
    this.#client = client;
  }

  bindSupervisorWake(supervisorWake: AgentGraphSupervisorWakeCoordinator): void {
    if (this.#supervisorWake) {
      throw new Error('Runtime Host Agent Graph supervisor wake coordinator is already bound');
    }
    this.#supervisorWake = supervisorWake;
  }

  async recover(): Promise<void> {
    await this.supervisorWake.recover();
    await this.coordinator.recover();
  }
}
