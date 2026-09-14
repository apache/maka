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
import { Button } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import type { WorkHubPresentationSnapshot } from '../../../../shared/workhub-presentation.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

/** The main window owns only this landing space; the live view keeps its React owner. */
export function WorkHubDock({ enabled, visible = true }: { enabled: boolean; visible?: boolean }) {
  const { presentation } = useWorkHubServices();
  const t = workHubLiveCopy[useUiLocale()];
  const element = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<WorkHubPresentationSnapshot>();
  const [backdrop, setBackdrop] = useState<string>();
  const [error, setError] = useState<string>();
  const previous = useRef({ enabled, visible });
  const needsRecovery = snapshot?.placement === 'docked' && snapshot.rendererCrashed;
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => {
    // Enabling WorkHub also activates its dock. Only subsequent navigation
    // returns a floating conversation, so a fresh shortcut cannot be undone.
    if (enabled && previous.current.enabled && visible && !previous.current.visible) void presentation.hide().catch(report);
    previous.current = { enabled, visible };
  }, [enabled, presentation, visible]);
  useEffect(() => {
    let active = true;
    const update = (next: WorkHubPresentationSnapshot) => {
      if (active) setSnapshot(next);
    };
    const unsubscribe = presentation.subscribe(update);
    void presentation.getSnapshot().then(update).catch(report);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [presentation]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    let frame = 0;
    let active = true;
    let revision = 0;
    let last = '';
    let covered = false;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const docked = snapshot?.placement === 'docked';
      const occluded = visible && docked && Array.from(document.querySelectorAll(':popover-open:not(:empty), dialog[open]')).some((overlay) => {
        if (overlay.matches(':modal')) return true;
        const bounds = overlay.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.left < rect.right && bounds.right > rect.left && bounds.top < rect.bottom && bounds.bottom > rect.top;
      });
      const host = {
        visible: visible && rect.width > 0 && rect.height > 0,
        occluded,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      const key = JSON.stringify(host);
      if (key !== last) {
        last = key;
        if (covered !== occluded) ++revision;
        covered = occluded;
        const current = revision;
        if (!occluded) setBackdrop(undefined);
        void presentation.setHost(host).then((image) => {
          if (active && current === revision && image) setBackdrop(image);
        }).catch(report);
      }
      // Menus animate and the sidebar can move without resizing this node.
      // Only changed geometry/occlusion crosses IPC.
      if (visible && docked) frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      void presentation
        .setHost({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } })
        .catch(() => undefined);
    };
  }, [presentation, visible, snapshot?.placement]);
  return (
    <section ref={element} className="workHubDock" hidden={!visible} aria-label={t.title}>
      {backdrop && snapshot?.placement === 'docked' && <img className="workHubDockBackdrop" src={backdrop} alt="" aria-hidden draggable={false} />}
      {(snapshot?.placement === 'floating' || needsRecovery) && (
        <div className="workHubDockPlaceholder">
          <h2>{needsRecovery ? t.reloadRequired : t.floating}</h2>
          <Button
            label={needsRecovery ? t.retry : t.restore}
            onClick={() => {
              setError(undefined);
              void presentation.dock().catch(report);
            }}
          />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
