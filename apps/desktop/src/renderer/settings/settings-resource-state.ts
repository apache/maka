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

export type SettingsResourcePhase = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A resource can keep a last-ready snapshot while a newer read is in flight
 * or has failed. Keeping availability separate from the request phase lets
 * Settings revalidate without replacing known values with defaults.
 */
export interface SettingsResourceState<T> {
  readonly key?: string;
  readonly snapshot?: T;
  readonly phase: SettingsResourcePhase;
  /** The current modal has confirmed this key with a successful read. */
  readonly isVerified: boolean;
  readonly message?: string;
}

export interface SettingsResourceStatus {
  readonly phase: SettingsResourcePhase;
  readonly hasSnapshot: boolean;
  readonly isVerified: boolean;
  readonly message?: string;
}

export function createSettingsResourceState<T>(
  key?: string,
  snapshot?: T,
): SettingsResourceState<T> {
  return {
    key,
    snapshot,
    phase: snapshot === undefined ? 'idle' : 'loading',
    isVerified: false,
  };
}

/**
 * Keeps the last snapshot visible while revoking the authority established by
 * an older Runtime Host generation. Ordinary same-generation refreshes use
 * `beginSettingsResourceLoad` instead so they retain verified SWR semantics.
 */
export function invalidateSettingsResourceGeneration<T>(
  current: SettingsResourceState<T>,
): SettingsResourceState<T> {
  return createSettingsResourceState(current.key, current.snapshot);
}

export function beginSettingsResourceLoad<T>(
  current: SettingsResourceState<T>,
  key: string,
  cachedSnapshot?: T,
): SettingsResourceState<T> {
  return {
    key,
    snapshot: current.key === key ? current.snapshot ?? cachedSnapshot : cachedSnapshot,
    phase: 'loading',
    isVerified: current.key === key && current.isVerified,
  };
}

export function completeSettingsResourceLoad<T>(
  key: string,
  snapshot: T,
): SettingsResourceState<T> {
  return { key, snapshot, phase: 'ready', isVerified: true };
}

export function failSettingsResourceLoad<T>(
  current: SettingsResourceState<T>,
  key: string,
  message: string,
  cachedSnapshot?: T,
): SettingsResourceState<T> {
  return {
    key,
    snapshot: current.key === key ? current.snapshot ?? cachedSnapshot : cachedSnapshot,
    phase: 'error',
    isVerified: current.key === key && current.isVerified,
    message,
  };
}

export function settingsResourceSnapshot<T>(
  state: SettingsResourceState<T>,
  key: string | undefined,
): T | undefined {
  return key !== undefined && state.key === key ? state.snapshot : undefined;
}

export function settingsResourceStatus<T>(
  state: SettingsResourceState<T>,
  key: string | undefined,
): SettingsResourceStatus {
  if (key === undefined || state.key !== key) {
    return { phase: 'idle', hasSnapshot: false, isVerified: false };
  }
  return {
    phase: state.phase,
    hasSnapshot: state.snapshot !== undefined,
    isVerified: state.isVerified,
    message: state.message,
  };
}

export function reconcileRuntimeHostProfileSelection(options: {
  currentProfileId: string | undefined;
  defaultProfileId: string;
  enabledProfileIds: readonly string[];
  preserveCurrentSelection: boolean;
}): string {
  return options.preserveCurrentSelection &&
    options.currentProfileId !== undefined &&
    options.enabledProfileIds.includes(options.currentProfileId)
    ? options.currentProfileId
    : options.defaultProfileId;
}
