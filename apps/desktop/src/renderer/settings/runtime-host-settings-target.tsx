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
