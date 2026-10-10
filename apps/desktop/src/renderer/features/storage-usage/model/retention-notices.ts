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

import type { StorageRetentionQueryResult } from '@maka/runtime-host/protocol';
import type { RetentionNoticeHost, RetentionNoticeState, StorageUsageHostTarget, StorageUsageServices } from '../ports.js';

export const RETENTION_NOTICE_POLL_MS = 60_000;
export const RETENTION_NOTICE_COOLDOWN_MS = 15 * 60_000;
const DISABLED_POLL_MS = 15 * 60_000;

export type RetentionNotice =
  | { readonly kind: 'deletion'; readonly deletion: NonNullable<StorageRetentionQueryResult['lastDeletion']> }
  | { readonly kind: 'hold'; readonly hold: NonNullable<StorageRetentionQueryResult['hold']> }
  | { readonly kind: 'paused' };

export function decodeRetentionNoticeState(value: unknown): RetentionNoticeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  return {
    ...(time(record.deletionAt) ? { deletionAt: record.deletionAt } : {}),
    ...(time(record.notifiedAt) ? { notifiedAt: record.notifiedAt } : {}),
    ...(typeof record.warning === 'string' ? { warning: record.warning } : {}),
    ...(typeof record.acknowledgedWarning === 'string'
      ? { acknowledgedWarning: record.acknowledgedWarning }
      : {}),
  };
}

function warningKey(retention: StorageRetentionQueryResult): string | undefined {
  if (!retention.enabled) return undefined;
  if (retention.hold) return `hold:${retention.revision}:${retention.hold.detectedAt}:${retention.hold.until}`;
  return retention.lastSweep?.paused ? `paused:${retention.revision}:${retention.lastSweep.at}` : undefined;
}

/** A result actually presented in Settings need not be announced again. */
export function acknowledgeRetentionResults(
  services: StorageUsageServices,
  host: StorageUsageHostTarget,
  retention: StorageRetentionQueryResult,
): void {
  const notices = services.notices;
  if (!notices) return;
  const previous = decodeRetentionNoticeState(notices.readSeen(host.hostId));
  const warning = warningKey(retention);
  const deletionAt = Math.max(previous.deletionAt ?? -1, retention.lastDeletion?.at ?? -1);
  const next = {
    ...previous,
    ...(deletionAt >= 0 ? { deletionAt } : {}),
    ...(warning ? { warning, acknowledgedWarning: warning } : {}),
  };
  if (next.deletionAt !== previous.deletionAt || next.warning !== previous.warning ||
    next.acknowledgedWarning !== previous.acknowledgedWarning) notices.writeSeen(host.hostId, next);
}

/**
 * Poll only connected Hosts while this window can present a notice. Host time
 * identifies results; Client time only throttles successive deletion batches.
 * Warnings are never throttled behind a deletion reminder.
 */
export function observeRetentionNotices(input: {
  readonly services: Pick<StorageUsageServices, 'loadRetention'> & {
    readonly notices: NonNullable<StorageUsageServices['notices']>;
  };
  readonly notify: (host: RetentionNoticeHost, notice: RetentionNotice) => (() => void) | void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => () => void;
}): () => void {
  const { services } = input;
  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  const seen = new Map<string, RetentionNoticeState>();
  const disabledReadAt = new Map<string, number>();
  const warnings = new Map<string, { readonly key: string; readonly dismiss: () => void }>();
  let closed = false;
  let version = 0;
  let running = false;
  let requested = false;
  let cancelTimer: (() => void) | undefined;

  async function refresh(): Promise<void> {
    if (closed) return;
    cancelTimer?.();
    cancelTimer = undefined;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    const started = version;
    try {
      if (!services.notices.isVisible()) return;
      const hosts = await services.notices.loadHosts();
      if (closed || started !== version) return;
      const present = new Set(hosts.map((host) => host.hostId));
      for (const hostId of disabledReadAt.keys()) {
        if (!present.has(hostId)) disabledReadAt.delete(hostId);
      }
      for (const [hostId, active] of warnings) {
        if (!present.has(hostId)) {
          active.dismiss();
          warnings.delete(hostId);
        }
      }
      const visited = new Set<string>();
      for (const host of hosts) {
        if (closed || started !== version || !services.notices.isVisible()) return;
        if (visited.has(host.hostId)) continue;
        visited.add(host.hostId);
        const acknowledged = decodeRetentionNoticeState(services.notices.readSeen(host.hostId));
        const previousWarning = warnings.get(host.hostId);
        if (previousWarning && previousWarning.key === acknowledged.acknowledgedWarning) {
          previousWarning.dismiss();
          warnings.delete(host.hostId);
        }
        const disabledAt = disabledReadAt.get(host.hostId);
        const elapsed = disabledAt === undefined ? undefined : now() - disabledAt;
        // Focus changes do not turn the default-disabled policy into a full
        // candidate scan every minute. A Client clock rollback forces a read.
        if (elapsed !== undefined && elapsed >= 0 && elapsed < DISABLED_POLL_MS) continue;
        let retention: StorageRetentionQueryResult;
        try {
          retention = await services.loadRetention(host);
        } catch {
          // A disconnected Host must not prevent notices from other Hosts.
          continue;
        }
        if (closed || started !== version || !services.notices.isVisible()) return;
        if (retention.enabled) disabledReadAt.delete(host.hostId);
        else disabledReadAt.set(host.hostId, now());
        const persisted = decodeRetentionNoticeState(services.notices.readSeen(host.hostId));
        const cached = seen.get(host.hostId);
        const deletionAt = Math.max(cached?.deletionAt ?? -1, persisted.deletionAt ?? -1);
        let state: RetentionNoticeState = {
          ...persisted,
          ...cached,
          ...(deletionAt >= 0 ? { deletionAt } : {}),
          ...(persisted.acknowledgedWarning ? { acknowledgedWarning: persisted.acknowledgedWarning } : {}),
        };
        const publish = (notice: RetentionNotice, next: RetentionNoticeState) => {
          const dismiss = input.notify(host, notice);
          if (notice.kind !== 'deletion' && next.warning && dismiss) warnings.set(host.hostId, { key: next.warning, dismiss });
          state = next;
          seen.set(host.hostId, state);
          services.notices.writeSeen(host.hostId, state);
        };
        const warning = warningKey(retention);
        const active = warnings.get(host.hostId);
        if (active && (active.key !== warning || active.key === persisted.acknowledgedWarning)) {
          active.dismiss();
          warnings.delete(host.hostId);
        }
        if (warning && warning === persisted.warning) state = { ...state, warning };
        if (warning && warning !== state.warning) {
          publish(retention.hold ? { kind: 'hold', hold: retention.hold } : { kind: 'paused' }, { ...state, warning });
        }
        const deletion = retention.lastDeletion;
        const time = now();
        const cooled = state.notifiedAt === undefined || time < state.notifiedAt || time - state.notifiedAt >= RETENTION_NOTICE_COOLDOWN_MS;
        if (deletion && deletion.count > 0 && deletion.at > (state.deletionAt ?? -1) && cooled) {
          publish({ kind: 'deletion', deletion }, { ...state, deletionAt: deletion.at, notifiedAt: time });
        }
      }
    } catch {
      // Profile discovery can be temporarily unavailable during Host handoff.
    } finally {
      running = false;
      if (!closed) {
        if (requested) {
          requested = false;
          void refresh();
        } else {
          cancelTimer = schedule(() => { void refresh(); }, RETENTION_NOTICE_POLL_MS);
        }
      }
    }
  }

  const unsubscribe = services.notices.subscribeChanges(() => {
    version += 1;
    void refresh();
  });
  void refresh();
  return () => {
    closed = true;
    cancelTimer?.();
    unsubscribe();
    for (const active of warnings.values()) active.dismiss();
    warnings.clear();
  };
}
