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
// Names the live holder of a shared dev profile from Chromium's own lock
// record, never from process-table reconstruction (#3539). Electron's
// requestSingleInstanceLock leaves a `SingletonLock` symlink in the user-data
// dir whose target encodes `<hostname>-<pid>`. This module is PURE: it parses
// and classifies the record, while reading the symlink and probing PID
// liveness are OS effects injected by the Desktop callers that own them.

/** One parsed `<hostname>-<pid>` SingletonLock target. */
export interface DevProfileOwnerRecord {
  readonly hostname: string;
  readonly pid: number;
}

/**
 * Parse a bare `<hostname>-<pid>` SingletonLock target into its hostname and
 * PID. Hostnames may themselves contain dashes, so the split runs from the
 * end: the last segment is the PID, everything before it is the hostname.
 * Only the bare record shape is accepted: anything path-shaped (a separator
 * anywhere) or otherwise malformed returns undefined rather than being
 * widened into a plausible owner.
 */
export function parseDevProfileLockTarget(target: string): DevProfileOwnerRecord | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes('/') || trimmed.includes('\\')) return undefined;
  const dash = trimmed.lastIndexOf('-');
  if (dash <= 0) return undefined;
  const pidText = trimmed.slice(dash + 1);
  if (!/^\d+$/.test(pidText)) return undefined;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const hostnamePart = trimmed.slice(0, dash);
  if (hostnamePart.length === 0) return undefined;
  return { hostname: hostnamePart, pid };
}

/**
 * Whether the PID still exists, as reported by the Desktop caller. `EPERM`
 * counts as alive there: an existing process owned by another user is a
 * holder we may not signal, not an empty slot.
 */
export type DevProfileLivenessProbe = (pid: number) => boolean;

/** A SingletonLock record classified against this machine. */
export interface DevProfileOwner extends DevProfileOwnerRecord {
  /** False when the lock was written by a different machine (shared homes). */
  readonly isLocalHost: boolean;
}

export interface DevProfileOwnerResolutionDeps {
  /** Required to classify the record; supplied by the Desktop caller. */
  localHostname?: string;
  /** Probes PID liveness; required for local records to count as holders. */
  liveness?: DevProfileLivenessProbe;
}

/**
 * Classify a SingletonLock target. The hostname is compared FIRST, and the
 * liveness probe runs only for records written by this machine: a remote
 * hostname must never be validated against the local process table (#3539).
 * Undefined when there is nothing trustworthy to report: a malformed record,
 * an unknown local hostname, or a local record whose PID is no longer alive
 * (stale debris from a holder that died without Cleanup()).
 */
export function resolveLiveDevProfileOwnerFromTarget(
  target: string,
  deps: DevProfileOwnerResolutionDeps = {},
): DevProfileOwner | undefined {
  const record = parseDevProfileLockTarget(target);
  if (!record) return undefined;
  const localHostname = deps.localHostname?.toLowerCase();
  if (!localHostname) return undefined;
  const isLocalHost = record.hostname.toLowerCase() === localHostname;
  if (isLocalHost) {
    try {
      if (!deps.liveness?.(record.pid)) return undefined;
    } catch {
      return undefined;
    }
  }
  return { ...record, isLocalHost };
}

/** Human-readable holder identity for embedding in conflict messages. */
export function describeDevProfileOwner(owner: DevProfileOwner): string {
  return owner.isLocalHost
    ? `PID ${owner.pid} on this machine`
    : `PID ${owner.pid} on host "${owner.hostname}"`;
}
