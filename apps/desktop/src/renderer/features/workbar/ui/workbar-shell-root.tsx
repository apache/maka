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

import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createWorkbarShellBridge } from '../controller/workbar-shell-bridge.js';

/** What the shell receives: stable commands plus the state it renders from. */
export type WorkbarShellProjection = ReturnType<typeof useWorkbarShellProjection>;

function useWorkbarShellProjection() {
  const bridge = useMemo(createWorkbarShellBridge, []);
  const selectors = useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState);
  return useMemo(() => ({
    bridge,
    commands: bridge.commands,
    selectors,
    LiveContextUsageProbe: bridge.LiveContextUsageProbe,
  }), [bridge, selectors]);
}

/**
 * Owns the per-shell bridge above the shell and hands it the projection, the
 * way `TaskEntryRoot` hands over `taskEntry`. The controller lives in
 * `WorkbarProvider`, which publishes into the bridge; this root re-renders
 * the shell only when the equality-selected shell state changes.
 */
export function WorkbarShellRoot(props: {
  readonly children: (workbar: WorkbarShellProjection) => ReactNode;
}) {
  return props.children(useWorkbarShellProjection());
}
