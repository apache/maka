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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkbarHostModel } from '../ui/workbar-host.js';

type PreviewKind = 'files' | 'browser';

/** Presentation-only state; the selected tab and session remain authoritative. */
export function useFocusedPreview(input: {
  host: WorkbarHostModel;
}) {
  const [request, setRequest] = useState<{ sessionId: string; kind: PreviewKind } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [composerTarget, setComposerTarget] = useState<HTMLElement | null>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const rightPanel = input.host.panelsState.right;
  const activeRightTab = rightPanel.tabs.find((tab) => tab.id === rightPanel.activeTabId);
  const focusedPreview = request && request.sessionId === input.host.activeId &&
    activeRightTab?.kind === request.kind && !rightPanel.launcherOpen &&
    !input.host.rightCollapsed && !input.host.hidden && input.host.workspace !== 'workhub'
      ? request.kind : null;

  useEffect(() => {
    if (request && !focusedPreview) {
      setRequest(null);
      setMinimized(false);
    }
  }, [request, focusedPreview]);

  useLayoutEffect(() => {
    const frame = surfaceRef.current?.closest('.maka-detail-with-artifacts');
    setComposerTarget(frame?.querySelector<HTMLElement>(':scope > .mainColumn .maka-chat-layout > :last-child > :last-child') ?? null);
  }, [input.host.activeId]);

  useLayoutEffect(() => {
    const frame = surfaceRef.current?.closest<HTMLElement>('.maka-detail-with-artifacts');
    if (!focusedPreview || !frame || !composerTarget) return;
    frame.dataset.previewFocused = focusedPreview;
    if (minimized) frame.dataset.previewDockMinimized = 'true';
    const measure = () => {
      const dockHeight = Math.ceil(composerTarget.getBoundingClientRect().height);
      frame.style.setProperty('--maka-focused-dock-height', `${dockHeight}px`);
      frame.style.setProperty('--maka-focused-composer-space', `${dockHeight + overlayHeight + 32}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerTarget);
    return () => {
      observer.disconnect();
      delete frame.dataset.previewFocused;
      delete frame.dataset.previewDockMinimized;
      frame.style.removeProperty('--maka-focused-dock-height');
      frame.style.removeProperty('--maka-focused-composer-space');
    };
  }, [focusedPreview, composerTarget, overlayHeight, minimized]);

  function toggle(kind: PreviewKind) {
    if (!input.host.activeId) return;
    setMinimized(false);
    const sessionId = input.host.activeId;
    setRequest((current) => current?.sessionId === sessionId && current.kind === kind
      ? null : { sessionId, kind });
  }

  return {
    focusedPreview, minimized, activeRightTab, composerTarget, surfaceRef, setOverlayHeight, toggle,
    minimize: () => {
      setMinimized(true);
      requestAnimationFrame(() => composerTarget?.querySelector<HTMLElement>('.maka-recent-turn-toggle')?.focus());
    },
    restore: () => {
      setMinimized(false);
      requestAnimationFrame(() => composerTarget?.querySelector<HTMLElement>('.maka-composer [contenteditable="true"]')?.focus());
    },
    clear: () => { setRequest(null); setMinimized(false); },
  };
}
