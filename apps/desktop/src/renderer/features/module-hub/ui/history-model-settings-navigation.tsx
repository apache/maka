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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SettingsSection } from '@maka/core/settings';

export function useHistoryModelSettingsNavigation(initialSection: () => SettingsSection) {
  const mainPaneRef = useRef<HTMLElement>(null);
  const [navigation, setNavigation] = useState<{
    section: SettingsSection;
    historyTarget?: 'models' | 'permissions';
    historyScrollTop?: number;
    restoringHistory?: boolean;
  }>(() => ({ section: initialSection() }));
  const navigate = useCallback((section: SettingsSection) => {
    setNavigation((current) => current.section === section && current.historyScrollTop === undefined
      ? current : { section });
  }, []);

  useEffect(() => {
    const pane = mainPaneRef.current;
    if (!navigation.restoringHistory || !pane) return;
    // The remounted control may load asynchronously. User interaction, failure,
    // navigation or the deadline retires this one-shot restoration.
    let frame = 0;
    let stopped = false;
    let restoredScroll = false;
    const owner = pane.ownerDocument;
    const interactions = ['focusin', 'pointerdown', 'keydown', 'wheel'] as const;
    const stop = () => {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      for (const event of interactions) owner.removeEventListener(event, stop, true);
    };
    const restore = () => {
      if (stopped) return;
      const marker = pane.querySelector<HTMLElement>(navigation.historyTarget === 'permissions'
        ? '[data-computer-history-permissions]' : '[data-computer-history-model]');
      if (marker && !restoredScroll) {
        pane.scrollTop = navigation.historyScrollTop ?? 0;
        restoredScroll = true;
      }
      if (marker?.querySelector('[role="alert"]')) { stop(); return; }
      const target = marker?.querySelector<HTMLButtonElement>('button');
      if (!target || target.matches(':disabled, [aria-disabled="true"]') || target.closest('[inert], [hidden]')) return;
      stop();
      target.focus({ preventScroll: true });
      pane.scrollTop = navigation.historyScrollTop ?? 0;
    };
    const schedule = () => {
      if (stopped) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(pane, { childList: true, subtree: true, attributes: true });
    const timeout = setTimeout(stop, 5_000);
    for (const event of interactions) owner.addEventListener(event, stop, true);
    schedule();
    return stop;
  }, [navigation]);

  function openHistoryTarget(section: 'models' | 'permissions') {
    setNavigation({
      section,
      historyTarget: section,
      historyScrollTop: mainPaneRef.current?.scrollTop ?? 0,
    });
    if (mainPaneRef.current) mainPaneRef.current.scrollTop = 0;
  }

  return {
    section: navigation.section,
    restoringHistory: navigation.restoringHistory === true,
    canReturnToHistory: navigation.section === navigation.historyTarget && navigation.historyScrollTop !== undefined,
    mainPaneRef,
    navigate,
    openHistoryModels() {
      openHistoryTarget('models');
    },
    openHistoryPermissions() {
      openHistoryTarget('permissions');
    },
    returnToHistory() {
      setNavigation((current) => current.section === current.historyTarget && current.historyScrollTop !== undefined
        ? { ...current, section: 'computer-history', restoringHistory: true } : current);
    },
  };
}

export type HistoryModelSettingsNavigationState = ReturnType<typeof useHistoryModelSettingsNavigation>;

export function HistoryModelSettingsNavigation({ initialSection, children }: {
  initialSection: () => SettingsSection;
  children(navigation: HistoryModelSettingsNavigationState): ReactNode;
}) {
  return children(useHistoryModelSettingsNavigation(initialSection));
}
