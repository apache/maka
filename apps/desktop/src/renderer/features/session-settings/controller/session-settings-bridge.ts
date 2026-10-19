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
  NewTaskSettings,
  SessionSettingsCommands,
  SessionSettingsController,
  SessionSettingsOverlays,
} from '../model/session-settings-contract.js';

export interface SessionSettingsReadState {
  readonly overlays: SessionSettingsOverlays;
  readonly newTask: NewTaskSettings;
}

const EMPTY_STATE: SessionSettingsReadState = {
  overlays: { modelConfiguration: {}, permissionMode: {}, planMode: {}, orchestrationMode: {} },
  newTask: { planMode: false, orchestrationMode: 'default' },
};

/** Per-shell command port and read store; the provider alone owns write state. */
export function createSessionSettingsBridge() {
  let controller: SessionSettingsController | undefined;
  let state = EMPTY_STATE;
  const listeners = new Set<() => void>();
  const publishState = (next: SessionSettingsReadState) => {
    if (state.overlays === next.overlays && state.newTask === next.newTask) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const commands: SessionSettingsCommands = {
    clear: (id) => controller?.clear(id),
    setSessionModel: (id, model) => controller?.setSessionModel(id, model) ?? Promise.resolve(false),
    setSessionThinkingLevel: (id, level) => controller?.setSessionThinkingLevel(id, level) ?? Promise.resolve(false),
    setSessionExecutor: (id, target) => controller?.setSessionExecutor(id, target) ?? Promise.resolve(false),
    setPermissionMode: (mode) => controller?.setPermissionMode(mode) ?? Promise.resolve(false),
    setPlanMode: (id, active) => controller?.setPlanMode(id, active) ?? Promise.resolve(false),
    setOrchestrationMode: (id, mode) => controller?.setOrchestrationMode(id, mode) ?? Promise.resolve(false),
    setNewTaskPlanMode: (active) => controller?.setNewTaskPlanMode(active),
    setNewTaskOrchestrationMode: (mode) => controller?.setNewTaskOrchestrationMode(mode),
    clearNewTaskPermissionChoice: () => controller?.clearNewTaskPermissionChoice(),
  };
  return {
    commands,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: SessionSettingsController) {
      controller = next;
      publishState({ overlays: next.overlays, newTask: next.newTask });
    },
    disconnect() {
      controller = undefined;
      publishState(EMPTY_STATE);
    },
  };
}

export type SessionSettingsBridge = ReturnType<typeof createSessionSettingsBridge>;
