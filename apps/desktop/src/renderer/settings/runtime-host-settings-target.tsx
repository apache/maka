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

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useToast } from "@maka/ui";
import type { DesktopRuntimeHostRef } from "../../preload/bridge-contract.js";

interface RuntimeHostSettingsTargetValue {
  readonly host: DesktopRuntimeHostRef;
  /**
   * Changes when Desktop replaces the selected Host without changing its
   * renderer-facing profileId:hostId pair. Host-owned sub-authorities use this
   * key to retire their own async work without remounting the Settings page.
   */
  readonly generationKey: string;
}

const RuntimeHostSettingsTargetContext =
  createContext<RuntimeHostSettingsTargetValue | null>(null);

export function RuntimeHostSettingsTarget(props: {
  readonly host?: DesktopRuntimeHostRef;
  readonly generation?: string;
  readonly children: ReactNode;
}) {
  const value = useMemo<RuntimeHostSettingsTargetValue | null>(() => {
    if (!props.host) return null;
    return {
      host: props.host,
      generationKey:
        `${props.host.profileId}:${props.host.hostId}@${props.generation ?? "unversioned"}`,
    };
  }, [props.generation, props.host]);
  return (
    <RuntimeHostSettingsTargetContext.Provider value={value}>
      {props.children}
    </RuntimeHostSettingsTargetContext.Provider>
  );
}

export function useRuntimeHostSettingsTarget(): DesktopRuntimeHostRef {
  const target = useContext(RuntimeHostSettingsTargetContext);
  if (!target) throw new Error("Runtime Host Settings target is unavailable");
  return target.host;
}

export function useOptionalRuntimeHostSettingsTarget(): DesktopRuntimeHostRef | undefined {
  return useContext(RuntimeHostSettingsTargetContext)?.host;
}

export function useRuntimeHostSettingsGenerationKey(): string {
  const target = useContext(RuntimeHostSettingsTargetContext);
  if (!target) throw new Error("Runtime Host Settings target is unavailable");
  return target.generationKey;
}

/**
 * Retires only the Host-owned controller below this boundary when the selected
 * Runtime Host enters a new lifecycle generation. Parent route, draft, scroll,
 * and focus state remain owned by their existing Settings components.
 */
export function RuntimeHostSettingsGenerationBoundary(props: {
  readonly children: ReactNode;
}) {
  const generationKey = useRuntimeHostSettingsGenerationKey();
  return <Fragment key={generationKey}>{props.children}</Fragment>;
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
