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

import { host } from 'nsh';

export type HostViewFilter =
  | { kind: 'all_computers' }
  | { kind: 'single_computer'; root_id: string };

export interface SavedHostItem {
  rootId: string;
  hostName: string;
  peerId: string;
  endpoints: string[];
  credentialId: string;
  lastConnectedAtMs: number | null;
  collapsedInAllView: boolean;
  connected: boolean;
  hasCredential: boolean;
}

export interface ActiveHostInfo {
  rootId: string;
  hostName: string;
  epoch: string;
  session: string;
  endpoints: string[];
}

export interface HostStateSnapshot {
  devicePeerId: string;
  filter: HostViewFilter;
  hosts: SavedHostItem[];
  active: ActiveHostInfo | null;
}

export interface ParsedTicketInfo {
  rootId: string;
  hostName: string;
  peerId: string;
  endpoints: string[];
  nonce: string;
  expiresAtMs: number;
  sasCode: string;
  devicePeerId: string;
}

export interface PairHostResult {
  sasCode: string;
  state: HostStateSnapshot;
}

export interface HostCallResult {
  events: unknown[];
}

export function formatSas(code: string): string {
  const digits = code.replace(/[^0-9]/g, '');
  return digits.length === 6 ? digits.slice(0, 3) + ' ' + digits.slice(3) : code;
}

export async function bootstrap(): Promise<HostStateSnapshot> {
  return (await host.call('ios.bootstrap', {})) as HostStateSnapshot;
}

export async function parseTicket(uri: string): Promise<ParsedTicketInfo> {
  return (await host.call('ios.parseTicket', { uri })) as ParsedTicketInfo;
}

export async function pairHost(uri: string): Promise<PairHostResult> {
  return (await host.call('ios.pairHost', { uri })) as PairHostResult;
}

export async function connectHost(rootId: string): Promise<HostStateSnapshot> {
  return (await host.call('ios.connectHost', { rootId })) as HostStateSnapshot;
}

export async function disconnectHost(): Promise<HostStateSnapshot> {
  return (await host.call('ios.disconnectHost', {})) as HostStateSnapshot;
}

export async function removeHost(rootId: string): Promise<HostStateSnapshot> {
  return (await host.call('ios.removeHost', { rootId })) as HostStateSnapshot;
}

export async function setFilter(filter: HostViewFilter): Promise<HostStateSnapshot> {
  return (await host.call('ios.setFilter', { filter })) as HostStateSnapshot;
}

export async function hostCall(
  endpoint: string,
  method: string,
  input: Record<string, unknown>,
): Promise<HostCallResult> {
  return (await host.call('ios.hostCall', { endpoint, method, input })) as HostCallResult;
}

export function onHostState(listener: (state: HostStateSnapshot) => void): () => void {
  return host.on('ios.hostState', (data) => {
    listener(data as HostStateSnapshot);
  });
}

export function onPairingUri(listener: (uri: string) => void): () => void {
  return host.on('ios.pairingUri', (data) => {
    const payload = data as { uri?: string } | null;
    if (payload && typeof payload.uri === 'string' && payload.uri.length > 0) {
      listener(payload.uri);
    }
  });
}
