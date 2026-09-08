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
export function WorkHubDock({ visible = true }: { visible?: boolean }) {
  const { presentation } = useWorkHubServices();
  const t = workHubLiveCopy[useUiLocale()];
  const element = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<WorkHubPresentationSnapshot>();
  const [error, setError] = useState<string>();
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
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      void presentation
        .setHost({
          visible: visible && rect.width > 0 && rect.height > 0,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        })
        .catch(report);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      void presentation
        .setHost({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } })
        .catch(() => undefined);
    };
  }, [presentation, visible]);
  return (
    <section ref={element} className="workHubDock" hidden={!visible} aria-label={t.title}>
      {snapshot?.placement === 'floating' && (
        <div className="workHubDockPlaceholder">
          <h2>{t.floating}</h2>
          <Button
            label={t.restore}
            onClick={() => {
              void presentation.dock().catch(report);
            }}
          />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
