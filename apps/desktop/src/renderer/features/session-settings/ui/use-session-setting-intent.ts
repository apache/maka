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
import { createSessionSettingsBridge } from '../controller/session-settings-bridge.js';
import type { SessionSettingValues, SessionSettingsOverlays } from '../model/session-settings-contract.js';
import { equalSessionModelConfigurationIntent } from '../session-model-configuration-intent.js';

type Selection = Partial<SessionSettingValues>;

function select(overlays: SessionSettingsOverlays, sessionId?: string): Selection {
  return sessionId ? {
    modelConfiguration: overlays.modelConfiguration[sessionId],
    permissionMode: overlays.permissionMode[sessionId],
    planMode: overlays.planMode[sessionId],
    orchestrationMode: overlays.orchestrationMode[sessionId],
  } : {};
}

function equal(left: Selection, right: Selection): boolean {
  const a = left.modelConfiguration;
  const b = right.modelConfiguration;
  return (a === b || Boolean(a && b && equalSessionModelConfigurationIntent(a, b))) &&
    left.permissionMode === right.permissionMode &&
    left.planMode === right.planMode &&
    left.orchestrationMode === right.orchestrationMode;
}

/**
 * The shell's remaining intent read: only its selected Session's four overlays.
 * No write controller is called here. Inactive Session writes do not wake it.
 */
export function useSessionSettingIntent(sessionId?: string) {
  const bridge = useMemo(createSessionSettingsBridge, []);
  const getSnapshot = useMemo(() => {
    let state: SessionSettingsOverlays | undefined;
    let selection: Selection = {};
    return () => {
      const nextState = bridge.getState();
      if (state !== nextState) {
        const next = select(nextState, sessionId);
        if (state === undefined || !equal(selection, next)) selection = next;
        state = nextState;
      }
      return selection;
    };
  }, [bridge, sessionId]);
  const overlay = useSyncExternalStore(bridge.subscribe, getSnapshot, getSnapshot);
  return { bridge, commands: bridge.commands, overlay };
}
