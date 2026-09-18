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

import type { IpcMain } from 'electron';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  formatHostHandoff,
  type HostHandoffAction,
  type HostHandoffPresentation,
  type HostHandoffView,
  type OpenHostHandoffSurface,
} from '@maka/runtime-host/client';

export interface DesktopHostHandoffPayload {
  readonly view: HostHandoffView;
  readonly presentation: HostHandoffPresentation;
}

interface OpenDesktopHandoff {
  readonly submit: (revision: string, action: HostHandoffAction) => void;
  readonly view: HostHandoffView;
}

/**
 * Host handoffs render inside the main window: background progress stays
 * silent and only attention views reach the renderer, which decides through
 * `runtime-host-handoff:decide`. Concurrent handoffs (e.g. Local plus an
 * enabled remote) each keep their own submit; the most recently updated one
 * owns the visible slot.
 */
export function createDesktopHostHandoffSurface(input: {
  ipcMain: IpcMain;
  send: (payload: DesktopHostHandoffPayload | null) => void;
  resolveLocale: () => Promise<UiLocale>;
}): OpenHostHandoffSurface {
  const open = new Map<number, OpenDesktopHandoff>();
  let sequence = 0;
  let activeId: number | undefined;
  const locale = input.resolveLocale().then(
    (resolved) => resolved,
    () => 'en' as UiLocale,
  );

  const currentEntry = (): OpenDesktopHandoff | undefined =>
    activeId === undefined ? undefined : open.get(activeId);
  const payloadFor = async (
    entry: OpenDesktopHandoff | undefined,
  ): Promise<DesktopHostHandoffPayload | null> =>
    entry
      ? { view: entry.view, presentation: formatHostHandoff(entry.view, await locale) }
      : null;
  const publish = (): void => {
    void payloadFor(currentEntry()).then((payload) => input.send(payload));
  };

  input.ipcMain.handle('runtime-host-handoff:current', () =>
    payloadFor(currentEntry()),
  );
  input.ipcMain.handle(
    'runtime-host-handoff:decide',
    (_event, payload: { revision?: unknown; action?: unknown }) => {
      if (typeof payload?.revision !== 'string' || typeof payload?.action !== 'string') return;
      for (const entry of open.values()) {
        const { view } = entry;
        if (
          view.revision === payload.revision &&
          view.state === 'attention' &&
          view.actions.includes(payload.action as HostHandoffAction)
        ) {
          entry.submit(view.revision, payload.action as HostHandoffAction);
          return;
        }
      }
    },
  );

  return (submit) => {
    const id = sequence++;
    return {
      update(view) {
        open.set(id, { submit, view });
        activeId = id;
        publish();
      },
      close() {
        open.delete(id);
        if (activeId === id) {
          activeId = [...open.keys()].pop();
          publish();
        }
      },
    };
  };
}
