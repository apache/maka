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
  const resizeRef = useRef<{
    frame: HTMLElement; kind: PreviewKind; sessionId: string;
    startWidth: number; width: number; previousWidth: string;
  } | null>(null);
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

  function finishResize() {
    const drag = resizeRef.current;
    if (!drag) return null;
    resizeRef.current = null;
    if (drag.previousWidth) drag.frame.style.setProperty('--maka-session-workbar-width', drag.previousWidth);
    else drag.frame.style.removeProperty('--maka-session-workbar-width');
    delete drag.frame.dataset.previewResizing;
    delete drag.frame.dataset.previewCollapseReady;
    return drag;
  }

  // A cancelled gesture, tab switch or unmount must not leave a temporary width.
  useEffect(() => () => { finishResize(); }, [input.host.activeId, activeRightTab?.id, input.host.hidden, input.host.rightCollapsed]);

  const rightResizable = {
    ...input.host.rightResizable,
    _onResizeStart: () => {
      input.host.rightResizable._onResizeStart();
      const frame = surfaceRef.current?.closest<HTMLElement>('.maka-detail-with-artifacts');
      const kind = activeRightTab?.kind;
      if (!frame || !input.host.activeId || focusedPreview || input.host.workspace === 'workhub' ||
        rightPanel.launcherOpen || input.host.hidden || input.host.rightCollapsed ||
        (kind !== 'browser' && kind !== 'files') ||
        (kind === 'files' && !frame.querySelector('.maka-artifact-preview-screen'))) return;
      const panel = frame.querySelector<HTMLElement>('.maka-session-workbar[data-placement="right"]');
      if (!panel || panel.getBoundingClientRect().width >= frame.getBoundingClientRect().width) return;
      const width = panel.getBoundingClientRect().width;
      resizeRef.current = { frame, kind, sessionId: input.host.activeId, startWidth: width, width,
        previousWidth: frame.style.getPropertyValue('--maka-session-workbar-width') };
      frame.dataset.previewResizing = 'true';
    },
    _onResizeMove: (delta: number) => {
      const drag = resizeRef.current;
      if (!drag) { input.host.rightResizable._onResizeMove(delta); return; }
      // Follow the divider beyond the ordinary panel cap. Only a completed
      // gesture with less than 240px of conversation left enters focus mode.
      drag.width = Math.max(input.host.rightResizable._minSizePx,
        Math.min(drag.frame.clientWidth - 120, drag.startWidth + delta));
      drag.frame.style.setProperty('--maka-session-workbar-width', `${drag.width}px`);
      if (drag.width > drag.startWidth && drag.frame.clientWidth - drag.width <= 240) {
        drag.frame.dataset.previewCollapseReady = 'true';
      } else delete drag.frame.dataset.previewCollapseReady;
    },
    _onResizeEnd: () => {
      const pending = resizeRef.current;
      const focus = pending?.frame.dataset.previewCollapseReady === 'true';
      const drag = finishResize();
      if (drag && focus) {
        setMinimized(false);
        setRequest({ sessionId: drag.sessionId, kind: drag.kind });
        requestAnimationFrame(() => composerTarget?.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus());
      } else if (drag) input.host.rightResizable._onResizeMove(drag.width - drag.startWidth);
      input.host.rightResizable._onResizeEnd();
    },
    _onResizeCancel: () => {
      finishResize();
      input.host.rightResizable._onResizeCancel?.();
    },
  };

  return {
    focusedPreview, minimized, activeRightTab, composerTarget, surfaceRef, setOverlayHeight, toggle, rightResizable,
    minimize: () => {
      setMinimized(true);
      requestAnimationFrame(() => composerTarget?.querySelector<HTMLElement>('.maka-progress-card-primary')?.focus());
    },
    restore: () => {
      setMinimized(false);
      requestAnimationFrame(() => composerTarget?.querySelector<HTMLElement>('.maka-composer [contenteditable="true"]')?.focus());
    },
    clear: () => { setRequest(null); setMinimized(false); },
  };
}
