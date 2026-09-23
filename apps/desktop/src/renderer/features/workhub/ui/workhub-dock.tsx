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

import { isNativeSurfaceOccluded, watchNativeSurface, type NativeSurfaceWatch } from '../../../application/contracts/native-surface-occlusion.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import type { WorkHubPresentationSnapshot } from '../../../../shared/workhub-presentation.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

/** The main window owns only this landing space; the live view keeps its React owner. */
export function WorkHubDock({ enabled, visible = true, workbar }: {
  enabled: boolean;
  visible?: boolean;
  workbar: { bottomOpen: boolean; rightCollapsed: boolean };
}) {
  const { presentation } = useWorkHubServices();
  const t = workHubLiveCopy[useUiLocale()];
  const element = useRef<HTMLElement>(null);
  const workbarRef = useRef({
    placement: workbar.bottomOpen ? 'bottom' as const : 'right' as const,
    collapsed: workbar.bottomOpen ? false : workbar.rightCollapsed,
  });
  workbarRef.current = {
    placement: workbar.bottomOpen ? 'bottom' : 'right',
    collapsed: workbar.bottomOpen ? false : workbar.rightCollapsed,
  };
  const [snapshot, setSnapshot] = useState<WorkHubPresentationSnapshot>();
  const [backdrop, setBackdrop] = useState<string>();
  const [error, setError] = useState<string>();
  const needsRecovery = snapshot?.placement === 'docked' && snapshot.rendererCrashed;
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
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
  const surface = useRef<NativeSurfaceWatch>(undefined);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    let active = true;
    let revision = 0;
    let last = '';
    let covered = false;
    const docked = snapshot?.placement === 'docked';
    const update = () => {
      const rect = node.getBoundingClientRect();
      const occluded = visible && docked && isNativeSurfaceOccluded(rect, node.ownerDocument);
      const host = {
        visible: enabled && visible && rect.width > 0 && rect.height > 0,
        occluded,
        workbar: workbarRef.current,
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
    };
    update();
    surface.current = visible && docked ? watchNativeSurface(node, update) : undefined;
    return () => {
      active = false;
      surface.current?.dispose();
      surface.current = undefined;
      void presentation
        .setHost({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } })
        .catch(() => undefined);
    };
  }, [enabled, presentation, visible, snapshot?.placement]);
  useEffect(() => surface.current?.refresh(), [workbar.bottomOpen, workbar.rightCollapsed]);
  return (
    <section ref={element} className="workHubDock" data-native-edge={snapshot?.placement === 'docked' && !needsRecovery || undefined} hidden={!visible} aria-label={t.title}>
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
