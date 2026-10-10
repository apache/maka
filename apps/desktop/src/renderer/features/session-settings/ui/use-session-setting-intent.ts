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

import { useMemo, useSyncExternalStore } from 'react';
import { createSessionSettingsBridge, type SessionSettingsReadState } from '../controller/session-settings-bridge.js';
import type { NewTaskSettings, SessionSettingValues, SessionSettingsOverlays } from '../model/session-settings-contract.js';
import { equalSessionModelConfigurationIntent } from '../session-model-configuration-intent.js';

type Selection = { readonly overlay: Partial<SessionSettingValues>; readonly newTask: NewTaskSettings };

function selectOverlay(overlays: SessionSettingsOverlays, sessionId?: string): Partial<SessionSettingValues> {
  return sessionId ? {
    modelConfiguration: overlays.modelConfiguration[sessionId],
    permissionMode: overlays.permissionMode[sessionId],
    planMode: overlays.planMode[sessionId],
    orchestrationMode: overlays.orchestrationMode[sessionId],
  } : {};
}

function equalOverlay(left: Partial<SessionSettingValues>, right: Partial<SessionSettingValues>): boolean {
  const a = left.modelConfiguration;
  const b = right.modelConfiguration;
  return (a === b || Boolean(a && b && equalSessionModelConfigurationIntent(a, b))) &&
    left.permissionMode === right.permissionMode &&
    left.planMode === right.planMode &&
    left.orchestrationMode === right.orchestrationMode;
}

/**
 * The shell's remaining intent read: only its selected Session's four overlays
 * and what the next new task starts with. No write controller is called here.
 * Inactive Session writes do not wake it.
 */
export function useSessionSettingIntent(sessionId?: string) {
  const bridge = useMemo(createSessionSettingsBridge, []);
  const getSnapshot = useMemo(() => {
    let state: SessionSettingsReadState | undefined;
    let selection: Selection | undefined;
    return () => {
      const nextState = bridge.getState();
      if (state !== nextState || !selection) {
        const nextOverlay = selectOverlay(nextState.overlays, sessionId);
        const overlay = selection && equalOverlay(selection.overlay, nextOverlay) ? selection.overlay : nextOverlay;
        if (overlay !== selection?.overlay || nextState.newTask !== selection.newTask) {
          selection = { overlay, newTask: nextState.newTask };
        }
        state = nextState;
      }
      return selection;
    };
  }, [bridge, sessionId]);
  const { overlay, newTask } = useSyncExternalStore(bridge.subscribe, getSnapshot, getSnapshot);
  return { bridge, commands: bridge.commands, overlay, newTask };
}
