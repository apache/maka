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

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useToast } from "@maka/ui";
import type { DesktopRuntimeHostRef } from "../../preload/bridge-contract.js";

const RuntimeHostSettingsTargetContext =
  createContext<DesktopRuntimeHostRef | null>(null);

export function RuntimeHostSettingsTarget(props: {
  readonly host?: DesktopRuntimeHostRef;
  readonly children: ReactNode;
}) {
  return (
    <RuntimeHostSettingsTargetContext.Provider value={props.host ?? null}>
      {props.children}
    </RuntimeHostSettingsTargetContext.Provider>
  );
}

export function useRuntimeHostSettingsTarget(): DesktopRuntimeHostRef {
  const host = useContext(RuntimeHostSettingsTargetContext);
  if (!host) throw new Error("Runtime Host Settings target is unavailable");
  return host;
}

export function useOptionalRuntimeHostSettingsTarget(): DesktopRuntimeHostRef | undefined {
  return useContext(RuntimeHostSettingsTargetContext) ?? undefined;
}

export function useRuntimeHostSettingsErrorReporter() {
  const host = useRuntimeHostSettingsTarget();
  const toast = useToast();
  return useCallback(
    (title: string, description?: string) =>
      toast.error(title, description, undefined, { profileId: host.profileId }),
    [host.profileId, toast],
  );
}
