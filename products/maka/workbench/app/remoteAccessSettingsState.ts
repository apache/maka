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

import { Clipboard, platform, signal } from 'nsh';
import { host } from 'maka/host';
import { tr } from './locale';
import { pairingQr } from './pairingQr';
import { createSettingsDiscard } from './settingsDiscard';

type RelayConfig = {
  endpoint: { url: string; quicPort: number | null; certSha256: string | null };
  caDerPath: string | null;
  hasAuthToken: boolean;
};
type Config = { enabled: boolean; relayOnly: boolean; relays: RelayConfig[] };
type Status = {
  config: Config;
  status: 'disabled' | 'starting' | 'connected' | 'error';
  peerId: string;
  connectedRelays: string[];
  sas: { peerId: string; sas: string; at: number } | null;
  error: string | null;
  cliOverride: boolean;
};
type Device = { peerId: string; label: string; createdAt: string; lastActiveAt: string | null };
type Invite = { uri: string; inviteId: string; expiresAtMs: number };
type RelayDraft = {
  id: number;
  url: string;
  quicPort: string;
  certSha256: string;
  caDerPath: string;
  hasAuthToken: boolean;
  auth: 'keep' | 'clear' | 'replace';
  token: string;
};
type Draft = { enabled: boolean; relayOnly: boolean; relays: RelayDraft[] };

export function createRemoteAccessSettings() {
  const status = signal<Status | null>(null);
  const devices = signal<Device[]>([]);
  const draft = signal<Draft | null>(null);
  const invite = signal<
    (Invite & { qr: ReturnType<typeof pairingQr>; requestedAt: number }) | null
  >(null);
  const confirming = signal<Device | null>(null);
  const busy = signal(false);
  const dirty = signal(false);
  const loadError = signal('');
  const actionError = signal('');
  const copied = signal('');
  const clock = signal(Date.now());
  let generation = 0;
  let observation = 0;
  let active = false;
  let nextId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let copyRequest = 0;

  const blank = (): RelayDraft => ({
    id: ++nextId,
    url: '',
    quicPort: '',
    certSha256: '',
    caDerPath: '',
    hasAuthToken: false,
    auth: 'keep',
    token: '',
  });
  const fromConfig = (config: Config): Draft => ({
    enabled: config.enabled,
    relayOnly: config.relayOnly,
    relays: config.relays.map((relay) => ({
      ...blank(),
      url: relay.endpoint.url,
      quicPort: String(relay.endpoint.quicPort ?? ''),
      certSha256: relay.endpoint.certSha256 ?? '',
      caDerPath: relay.caDerPath ?? '',
      hasAuthToken: relay.hasAuthToken,
    })),
  });
  const reset = (config: Config) => {
    draft.set(fromConfig(config));
    dirty.set(false);
  };
  const cancelRevoke = () => {
    confirming.set(null);
    actionError.set('');
  };
  const discarding = createSettingsDiscard(dirty, () => reset(status()!.config));
  const setDraft = (value: Draft) => {
    draft.set(value);
    dirty.set(true);
    actionError.set('');
  };
  const load = async (run: number) => {
    if (!active) return;
    const id = ++observation;
    const current = () => run === generation && id === observation;
    try {
      const [next, peers] = await Promise.all([
        host.remoteAccessStatus(),
        host.listPairedDevices(),
      ]);
      if (!current()) return;
      const live = next as Status;
      const previous = status()?.config;
      if (!dirty() && JSON.stringify(previous) !== JSON.stringify(live.config)) reset(live.config);
      const paired = peers as Device[];
      const notice = live.sas ?? status()?.sas;
      const pairing = invite();
      if (
        pairing &&
        notice &&
        notice.at >= pairing.requestedAt &&
        paired.some((device) => device.peerId === notice.peerId)
      ) {
        invite.set(null);
      }
      devices.set(paired);
      status.set(live);
      loadError.set('');
    } catch (error) {
      if (current()) loadError.set(String(error));
    }
  };
  const tick = async (run: number) => {
    if (run !== generation) return;
    if (!busy()) await load(run);
    if (run === generation) timer = setTimeout(() => void tick(run), 1000);
  };
  const perform = async (operation: (current: () => boolean) => Promise<void>) => {
    if (busy()) return;
    const run = generation;
    const current = () => run === generation;
    busy.set(true);
    actionError.set('');
    try {
      await operation(current);
    } catch (error) {
      if (current()) actionError.set(String(error));
    } finally {
      if (current()) busy.set(false);
    }
  };
  const portError = (relay: RelayDraft) =>
    relay.quicPort.trim() &&
    (!/^\d+$/.test(relay.quicPort.trim()) ||
      Number(relay.quicPort) < 1 ||
      Number(relay.quicPort) > 65535);
  const urlError = (relay: RelayDraft) => !host.validRemoteRelayUrl(relay.url.trim());
  const canPair = () =>
    !loadError() && status()?.status === 'connected' && !!status()?.connectedRelays.length;
  const apply = async ({ enabled, relayOnly, relays }: Draft) => {
    if ((enabled && !relays.length) || relays.some(urlError))
      throw new Error(tr('Enter an HTTP or HTTPS relay URL.'));
    if (relays.some(portError)) throw new Error(tr('Enter a port from 1 to 65535.'));
    return (await host.updateRemoteAccess(
      {
        enabled,
        relayOnly,
        relays: relays.map((relay) => ({
          endpoint: {
            url: relay.url.trim(),
            quicPort: relay.quicPort.trim() ? Number(relay.quicPort) : null,
            certSha256: relay.certSha256.trim() || null,
          },
          caDerPath: relay.caDerPath.trim() || null,
          auth: { kind: relay.auth },
        })),
      },
      relays.map((relay) => (relay.auth === 'replace' ? relay.token : null)),
    )) as Config;
  };
  return {
    status,
    devices,
    draft,
    invite,
    confirming,
    busy,
    dirty,
    loadError,
    actionError,
    copied,
    discarding,
    portError,
    urlError,
    canPair,
    secondsLeft: () => Math.max(0, Math.ceil(((invite()?.expiresAtMs ?? 0) - clock()) / 1000)),
    sas: () => {
      const notice = status()?.sas;
      const pairing = invite();
      const now = clock();
      return notice &&
        pairing &&
        now < pairing.expiresAtMs &&
        notice.at >= pairing.requestedAt &&
        now - notice.at < 120_000 &&
        !devices().some((device) => device.peerId === notice.peerId)
        ? notice
        : null;
    },
    activate() {
      if (active || platform.idiom === 'terminal') return;
      active = true;
      clock.set(Date.now());
      clockTimer = setInterval(() => clock.set(Date.now()), 1000);
      void tick(++generation);
    },
    deactivate() {
      active = false;
      ++generation;
      clearTimeout(timer);
      clearTimeout(copyTimer);
      clearInterval(clockTimer);
      busy.set(false);
      status.set(null);
      draft.set(null);
      devices.set([]);
      confirming.set(null);
      invite.set(null);
      copied.set('');
      dirty.set(false);
      loadError.set('');
      actionError.set('');
      discarding.clear();
    },
    refresh: () => load(generation),
    discard() {
      reset(status()!.config);
      actionError.set('');
    },
    cancelRevoke,
    confirmRevoke(device: Device) {
      actionError.set('');
      confirming.set(device);
    },
    back() {
      if (confirming()) {
        cancelRevoke();
        return false;
      }
      return !discarding.back();
    },
    navigation: () => (confirming() ? 'revoke' : 'remote-access'),
    leave: discarding.leave,
    setEnabled(enabled: boolean) {
      const value = draft()!;
      setDraft({
        ...value,
        enabled,
        relays: enabled && !value.relays.length ? [blank()] : value.relays,
      });
    },
    setRelayOnly(relayOnly: boolean) {
      setDraft({ ...draft()!, relayOnly });
    },
    editRelay(id: number, edit: Partial<RelayDraft>) {
      const value = draft()!;
      setDraft({
        ...value,
        relays: value.relays.map((relay) => (relay.id === id ? { ...relay, ...edit } : relay)),
      });
    },
    addRelay() {
      const value = draft()!;
      setDraft({ ...value, relays: [...value.relays, blank()] });
    },
    removeRelay(id: number) {
      const value = draft()!;
      setDraft({ ...value, relays: value.relays.filter((relay) => relay.id !== id) });
    },
    save: () =>
      void perform(async (current) => {
        const next = draft()!;
        const config = await apply(
          next.enabled ? next : { ...fromConfig(status()!.config), enabled: false },
        );
        if (!current()) return;
        invite.set(null);
        reset(config);
        await load(generation);
      }),
    retry: () =>
      void perform(async (current) => {
        await apply(fromConfig(status()!.config));
        if (!current()) return;
        invite.set(null);
        await load(generation);
      }),
    pair: () =>
      void perform(async (current) => {
        if (!canPair()) return;
        const requestedAt = Date.now();
        const fresh = (await host.prepareDevicePairing()) as Invite;
        if (!current()) return;
        copied.set('');
        clock.set(Date.now());
        invite.set({ ...fresh, requestedAt, qr: pairingQr(fresh.uri) });
      }),
    revoke: () =>
      void perform(async (current) => {
        const peer = confirming()!;
        await host.revokePairedDevice(peer.peerId);
        if (!current()) return;
        confirming.set(null);
        await load(generation);
      }),
    async copy(key: string, value: string) {
      const run = generation;
      const request = ++copyRequest;
      const current = () => run === generation && request === copyRequest;
      try {
        await Clipboard.writeText(value);
        if (!current()) return;
        copied.set(key);
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => copied.set(''), 2000);
      } catch (error) {
        if (current()) actionError.set(String(error));
      }
    },
  };
}

export type RemoteAccessSettingsOwner = ReturnType<typeof createRemoteAccessSettings>;
