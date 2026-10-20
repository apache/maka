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

import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { SettingsSection } from '@maka/core/settings';

export interface SettingsNavigation {
  openSettingsSection(section: SettingsSection): void;
}

export const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);

export function useSettingsNavigation(): SettingsNavigation {
  const navigation = useContext(SettingsNavigationContext);
  if (!navigation) throw new Error('SettingsNavigationProvider is missing');
  return navigation;
}

export function SettingsNavigationProvider(props: {
  navigation: SettingsNavigation;
  children: ReactNode;
}) {
  return <SettingsNavigationContext.Provider value={props.navigation}>{props.children}</SettingsNavigationContext.Provider>;
}

export type SettingsNavigate = (action: () => void) => Promise<void>;
type LeaveCheck = () => Promise<boolean>;
const SettingsLeaveContext = createContext<RefObject<LeaveCheck | null> | null>(null);

/** The current editor protects explicit navigation without owning routing. */
export function SettingsNavigationGuard({ children }: {
  children: ReactNode | ((navigate: SettingsNavigate) => ReactNode);
}) {
  const inherited = useContext(SettingsLeaveContext);
  const local = useRef<LeaveCheck | null>(null);
  const check = inherited ?? local;
  const navigate: SettingsNavigate = async (action) => {
    if (!check.current || await check.current()) action();
  };
  return <SettingsLeaveContext.Provider value={check}>
    {typeof children === 'function' ? children(navigate) : children}
  </SettingsLeaveContext.Provider>;
}

export function SettingsLeaveCheck({ onLeave }: { onLeave: LeaveCheck }) {
  const check = useContext(SettingsLeaveContext);
  useEffect(() => {
    if (!check) return;
    check.current = onLeave;
    return () => { if (check.current === onLeave) check.current = null; };
  }, [check, onLeave]);
  return null;
}

/** Escape uses the same editor check as the Settings navigation buttons. */
export function SettingsDismissal({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const check = useContext(SettingsLeaveContext);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'escape' || event.defaultPrevented ||
        event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      void (async () => { if (!check?.current || await check.current()) closeRef.current(); })();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [check]);
  return children;
}
