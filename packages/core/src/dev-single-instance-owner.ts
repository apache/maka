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
// dir whose target encodes `<hostname>-<pid>`. The symlink alone is not
// evidence — it survives SIGKILL — so a holder is reported only while its PID
// is still alive, and any inconsistency degrades to "unknown" so every caller
// can fall back to the generic conflict wording.

import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import process from 'node:process';

/** One parsed `<hostname>-<pid>` SingletonLock target. */
export interface DevProfileOwnerRecord {
  readonly hostname: string;
  readonly pid: number;
}

/**
 * Parse the SingletonLock symlink target into its hostname and PID. Hostnames
 * may themselves contain dashes, so the split runs from the end: the last
 * segment is the PID, everything before it is the hostname. Returns undefined
 * for anything malformed rather than guessing.
 */
export function parseDevProfileLockTarget(target: string): DevProfileOwnerRecord | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  // Defensive: older layouts are documented with a path-shaped target; take
  // the final path segment either way.
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
  const dash = name.lastIndexOf('-');
  if (dash <= 0) return undefined;
  const pidText = name.slice(dash + 1);
  if (!/^\d+$/.test(pidText)) return undefined;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const hostnamePart = name.slice(0, dash);
  if (hostnamePart.length === 0) return undefined;
  return { hostname: hostnamePart, pid };
}

/**
 * Whether the PID still exists. `EPERM` counts as alive: an existing process
 * owned by another user is a holder we may not signal, not an empty slot.
 */
export type DevProfileLivenessProbe = (pid: number) => boolean;

function defaultLivenessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** A SingletonLock whose recorded PID is still alive. */
export interface DevProfileOwner extends DevProfileOwnerRecord {
  /** False when the lock was written by a different machine (shared homes). */
  readonly isLocalHost: boolean;
}

export interface DevProfileOwnerResolutionDeps {
  /** Defaults to reading `<userDataDir>/SingletonLock`. */
  readLockTarget?(): string | undefined;
  liveness?: DevProfileLivenessProbe;
  /** Defaults to this machine's hostname. */
  localHostname?: string;
}

/**
 * Resolve the profile holder from the lock's own record, or undefined when
 * there is nothing trustworthy to report: no readable symlink, a malformed
 * target, or a PID that no longer exists. A dead PID means the symlink is
 * stale debris (the holder died without Cleanup()) — reportable as no holder.
 */
export function resolveLiveDevProfileOwner(
  userDataDir: string,
  deps: DevProfileOwnerResolutionDeps = {},
): DevProfileOwner | undefined {
  let target: string | undefined;
  try {
    target = deps.readLockTarget?.() ?? readTarget(userDataDir);
  } catch {
    return undefined;
  }
  if (target === undefined) return undefined;
  const record = parseDevProfileLockTarget(target);
  if (!record) return undefined;
  const liveness = deps.liveness ?? defaultLivenessProbe;
  try {
    if (!liveness(record.pid)) return undefined;
  } catch {
    return undefined;
  }
  const local = (deps.localHostname ?? hostname()).toLowerCase();
  return { ...record, isLocalHost: record.hostname.toLowerCase() === local };
}

/** Human-readable holder identity for embedding in conflict messages. */
export function describeDevProfileOwner(owner: DevProfileOwner): string {
  return owner.isLocalHost
    ? `PID ${owner.pid} on this machine`
    : `PID ${owner.pid} on host "${owner.hostname}"`;
}

function readTarget(userDataDir: string): string | undefined {
  const target = readlinkSync(`${userDataDir}/SingletonLock`, 'utf8');
  return target.length > 0 ? target : undefined;
}
