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

import { signal } from 'nsh';
import type { Output } from './host';
import { tr, type MessageKey } from './locale';

export type Grant = 'microphone' | 'screen_recording' | 'accessibility' | 'disk' | 'files';
type Microphone = 'granted' | 'denied' | 'notDetermined' | 'restricted' | 'unknown';
export type DesktopStatus =
  | { supported: false }
  | {
      supported: true;
      application: string;
      canReveal: boolean;
      canRestart: boolean;
      microphone: Microphone;
      accessibility: boolean;
      screen_recording: boolean;
    };
export type HostStatus = { local: boolean; status: Output<'agent', 'hostPermissions'> };
export type Subject = 'desktop' | 'host';
type Action = 'open' | 'reveal' | 'request' | 'restart' | 'end' | 'guide';
type GuidedGrant = 'accessibility' | 'screen_recording';
export type Observation = { effective: boolean; pendingHost: boolean };
interface Client {
  observePermissionSetting(subject: Subject, grant: GuidedGrant): Promise<Observation | null>;
  desktopPermissionSettings(): Promise<DesktopStatus>;
  hostPermissionSettings(): Promise<HostStatus>;
  performPermissionSetting(subject: Subject, action: Action, grant: Grant): Promise<void>;
}
export const names: Record<Grant, MessageKey> = {
  microphone: 'Microphone',
  accessibility: 'Accessibility',
  screen_recording: 'Screen & System Audio Recording',
  files: 'Files and folders',
  disk: 'Full disk access',
};
export function statusLabel(state: Microphone | boolean | undefined) {
  switch (state) {
    case true:
    case 'granted':
      return 'Allowed';
    case false:
      return 'permissionSetup.notEnabled';
    case 'restricted':
      return 'Restricted';
    case 'notDetermined':
      return 'Not requested';
    case 'denied':
      return 'Denied';
    default:
      return 'Unknown';
  }
}
export function createPermissionSettings(client: Client) {
  const desktop = signal<DesktopStatus | null>(null);
  const host = signal<HostStatus | null>(null);
  const desktopError = signal('');
  const hostError = signal('');
  const actionError = signal('');
  const busy = signal(false);
  let active = false;
  let generation = 0;
  let observation = 0;
  const restartHint = signal<GuidedGrant | null>(null);
  let guide: {
    subject: Subject;
    grant: GuidedGrant;
    awaitingGrant: boolean;
    needsSettings: boolean;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stopGuide() {
    clearTimeout(timer);
    const previous = guide;
    guide = null;
    if (previous)
      void client.performPermissionSetting(previous.subject, 'end', previous.grant).catch(() => {});
  }
  function poll(target: NonNullable<typeof guide>, remaining = 32) {
    timer = setTimeout(
      async () => {
        if (target !== guide || !active) return;
        try {
          const state = await client.observePermissionSetting(target.subject, target.grant);
          if (target !== guide) return;
          if (!state) {
            stopGuide();
            return;
          }
          if (target.subject === 'desktop') {
            const d = desktop();
            if (d?.supported) desktop.set({ ...d, [target.grant]: state.effective });
            restartHint.set(state.effective ? null : target.grant);
          } else {
            const h = host();
            if (!h?.local) {
              stopGuide();
              return;
            }
            host.set({
              ...h,
              status: {
                ...h.status,
                grants: h.status.grants.map((g) =>
                  g.grant === target.grant ? { ...g, ...state } : g,
                ),
              },
            });
          }
          if (target.awaitingGrant && state.effective) {
            stopGuide();
            return;
          }
          if (target.needsSettings && !state.effective && !state.pendingHost) {
            target.needsSettings = false;
            await client.performPermissionSetting(target.subject, 'guide', target.grant);
          }
          if (target === guide && remaining > 1 && !state.effective) poll(target, remaining - 1);
        } catch (e) {
          if (target === guide) {
            actionError.set(String(e));
            stopGuide();
          }
        }
      },
      target.needsSettings ? 1750 : 1250,
    );
  }
  async function refresh() {
    if (!active) return;
    const token = ++observation;
    async function read<T>(
      query: () => Promise<T>,
      store: (v: T | null) => void,
      error: (s: string) => void,
    ) {
      try {
        const value = await query();
        if (token === observation) {
          store(value);
          error('');
        }
      } catch (e) {
        if (token === observation) {
          store(null);
          error(String(e));
        }
      }
    }
    await Promise.all([
      read(
        client.desktopPermissionSettings,
        (v) => desktop.set(v),
        (e) => desktopError.set(e),
      ),
      read(
        client.hostPermissionSettings,
        (v) => host.set(v),
        (e) => hostError.set(e),
      ),
    ]);
    if (token !== observation) return;
    const d = desktop();
    if (guide?.subject === 'desktop' && d?.supported && !d[guide.grant])
      restartHint.set(guide.grant);
    const hint = restartHint();
    if (hint && d?.supported && d[hint]) restartHint.set(null);
    if (
      guide?.subject === 'host' &&
      (!host()?.local ||
        (guide.awaitingGrant &&
          host()?.status.grants.some((g) => g.grant === guide?.grant && g.effective)))
    )
      stopGuide();
    if (guide?.subject === 'desktop' && guide.awaitingGrant && d?.supported && d[guide.grant])
      stopGuide();
  }
  async function act(subject: Subject, action: Action, grant: Grant) {
    if (!active || busy() || (subject === 'host' && !host()?.local)) return;
    const d = desktop();
    if (subject === 'desktop' && !d?.supported) return;
    if (
      action === 'restart' &&
      (subject !== 'desktop' || restartHint() !== grant || !d?.supported || !d.canRestart)
    )
      return;
    if (action === 'open' || action === 'request') {
      stopGuide();
      restartHint.set(null);
      if (grant === 'screen_recording' || grant === 'accessibility') {
        const effective =
          subject === 'desktop'
            ? d?.supported && d[grant]
            : host()?.status.grants.find((g) => g.grant === grant)?.effective;
        guide = {
          subject,
          grant,
          awaitingGrant: effective === false,
          needsSettings: action === 'request',
        };
      }
    }
    const token = generation;
    busy.set(true);
    actionError.set('');
    try {
      await client.performPermissionSetting(subject, action, grant);
      if (token === generation && guide && (action === 'open' || action === 'request')) poll(guide);
    } catch (e) {
      if (token === generation && (action === 'open' || action === 'request')) stopGuide();
      if (token === generation)
        actionError.set(
          action === 'open'
            ? tr('Open System Settings → Privacy & Security → {permission}.', {
                permission: tr(names[grant]),
              })
            : action === 'restart'
              ? tr('permissionGuide.restartFailed')
              : String(e),
        );
    } finally {
      if (token === generation) {
        busy.set(false);
        await refresh();
      }
    }
  }
  return {
    desktop,
    restartHint,
    host,
    desktopError,
    hostError,
    actionError,
    busy,
    refresh,
    act,
    activate() {
      active = true;
      void refresh();
    },
    deactivate() {
      active = false;
      stopGuide();
      restartHint.set(null);
      generation++;
      observation++;
      desktop.set(null);
      host.set(null);
      busy.set(false);
      actionError.set('');
      desktopError.set('');
      hostError.set('');
    },
    back: () => false,
    navigation: () => 'system-permissions',
  };
}
