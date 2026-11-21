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

import { host as shell, openUrl, platform, signal } from 'nsh';

export type UpdateChannel = 'dev' | 'nightly' | 'release';

export type UpdateStatus =
  | 'idle'
  | 'upToDate'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export type AvailableUpdate = {
  version: string;
  notes?: string | null;
  url: string;
  sha256?: string | null;
  size?: number | null;
};

export type UpdateProgress = {
  received: number;
  total?: number | null;
};

export type UpdaterSnapshot = {
  channel: UpdateChannel;
  currentVersion: string;
  canInstall: boolean;
  status: UpdateStatus;
  available?: AvailableUpdate | null;
  progress?: UpdateProgress | null;
  error?: string | null;
};

function isSnapshot(value: unknown): value is UpdaterSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.channel === 'dev' ||
      candidate.channel === 'nightly' ||
      candidate.channel === 'release') &&
    typeof candidate.currentVersion === 'string' &&
    typeof candidate.canInstall === 'boolean' &&
    typeof candidate.status === 'string'
  );
}

export function createAppUpdater(
  bridge: {
    call: (method: string, payload?: unknown) => Promise<unknown>;
    on: (event: string, listener: (payload: unknown) => void) => () => void;
    openUrl: (url: string) => Promise<unknown>;
  },
  supported: boolean,
) {
  const snapshot = signal<UpdaterSnapshot | null>(null);
  const dismissedVersion = signal<string | null>(null);
  let initialized = false;

  const apply = (value: unknown) => {
    if (!isSnapshot(value)) return;
    const prev = snapshot();
    snapshot.set(value);
    if (value.available?.version && value.available.version !== prev?.available?.version) {
      dismissedVersion.set(null);
    }
  };

  const init = () => {
    if (!supported || initialized) return;
    initialized = true;
    bridge.on('updater.state', apply);
    void bridge
      .call('updater.state')
      .then(apply)
      .catch(() => undefined);
  };

  const check = async () => {
    if (!supported) return;
    dismissedVersion.set(null);
    try {
      apply(await bridge.call('updater.check'));
    } catch (error) {
      const current = snapshot();
      if (current) {
        snapshot.set({
          ...current,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const download = async () => {
    if (!supported) return;
    dismissedVersion.set(null);
    try {
      apply(await bridge.call('updater.download'));
    } catch (error) {
      const current = snapshot();
      if (current) {
        snapshot.set({
          ...current,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const installAndRestart = async () => {
    if (!supported) return;
    try {
      await bridge.call('updater.installAndRestart');
    } catch (error) {
      const current = snapshot();
      if (current) {
        snapshot.set({
          ...current,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const openDownload = async () => {
    const url = snapshot()?.available?.url;
    if (!url) return;
    await bridge.openUrl(url).catch(() => undefined);
  };

  const dismiss = () => {
    const version = snapshot()?.available?.version;
    if (version) dismissedVersion.set(version);
  };

  const bannerVisible = () => {
    const current = snapshot();
    if (!current || current.channel === 'dev') return false;
    if (
      current.status !== 'available' &&
      current.status !== 'downloading' &&
      current.status !== 'ready' &&
      current.status !== 'installing'
    ) {
      return false;
    }
    if (
      (current.status === 'available' || current.status === 'ready') &&
      current.available?.version &&
      dismissedVersion() === current.available.version
    ) {
      return false;
    }
    return true;
  };

  const progressPercent = () => {
    const progress = snapshot()?.progress;
    if (!progress || !progress.total || progress.total <= 0) return null;
    return Math.min(100, Math.max(0, Math.round((progress.received / progress.total) * 100)));
  };

  return {
    supported,
    snapshot,
    init,
    check,
    download,
    installAndRestart,
    openDownload,
    dismiss,
    bannerVisible,
    progressPercent,
  };
}

export const appUpdater = createAppUpdater(
  {
    call: (method, payload) => shell.call(method, payload ?? {}),
    on: (event, listener) => shell.on(event, listener),
    openUrl: (url) => openUrl(url),
  },
  platform.idiom !== 'terminal',
);
