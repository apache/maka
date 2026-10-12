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

import type { MakaBridge } from './bridge-contract.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';

type Bridge = MakaBridge['clientPlugins'];
type Request = Parameters<Bridge['remoteCall']>[0];

/** Bind renderer snapshots and streams to their originating Host, not the current selection. */
export function createClientPluginRouting(deps: {
  activeScope(): Promise<DesktopTargetScope>;
  sessionRef(id: string): Promise<{ scope: DesktopTargetScope; sessionId: string }>;
  invoke<T>(channel: string, scope: DesktopTargetScope, input?: unknown): Promise<T>;
}): Bridge {
  const snapshots = new Map<string, { scope: DesktopTargetScope; revision: string; wireRevision: string }>();
  const streams = new Map<string, { scope: DesktopTargetScope; streamId: string }>();
  const scopeKey = (scope: DesktopTargetScope) => JSON.stringify([scope.hostId, scope.targetEpoch]);
  const route = async (input: Request) => {
    const owner = [...snapshots.values()].find(({ revision }) => revision === input.revision);
    if (!owner) throw new Error('Client Plugin snapshot is stale or unavailable');
    const session = input.sessionId ? await deps.sessionRef(input.sessionId) : undefined;
    if (session && scopeKey(session.scope) !== scopeKey(owner.scope)) {
      throw new Error('Client Plugin snapshot and Session belong to different Runtime Hosts');
    }
    return { scope: session?.scope ?? owner.scope, input: {
      ...input, revision: owner.wireRevision,
      ...(session ? { sessionId: session.sessionId } : {}),
    } };
  };
  return {
    async snapshot() {
      const scope = await deps.activeScope();
      const snapshot = await deps.invoke<Awaited<ReturnType<Bridge['snapshot']>>>('client-plugins:snapshot', scope);
      const revision = JSON.stringify([scopeKey(scope), snapshot.revision]);
      snapshots.set(scope.hostId, { scope, revision, wireRevision: snapshot.revision });
      return { ...snapshot, revision };
    },
    async remoteCall(input) {
      const routed = await route(input);
      return deps.invoke('client-plugins:remote:call', routed.scope, routed.input);
    },
    async remoteStreamOpen(input) {
      const routed = await route(input);
      const opened = await deps.invoke<Awaited<ReturnType<Bridge['remoteStreamOpen']>>>('client-plugins:remote:stream:open', routed.scope, routed.input);
      const streamId = JSON.stringify([scopeKey(routed.scope), opened.streamId]);
      streams.set(streamId, { scope: routed.scope, streamId: opened.streamId });
      return { streamId };
    },
    async remoteStreamNext({ streamId }) {
      const owner = streams.get(streamId);
      if (!owner) return { done: true };
      const result = await deps.invoke<Awaited<ReturnType<Bridge['remoteStreamNext']>>>('client-plugins:remote:stream:next', owner.scope, { streamId: owner.streamId });
      if (result.done) streams.delete(streamId);
      return result;
    },
    async remoteStreamClose({ streamId }) {
      const owner = streams.get(streamId);
      if (!owner) return { streamId };
      const result = await deps.invoke<Awaited<ReturnType<Bridge['remoteStreamClose']>>>('client-plugins:remote:stream:close', owner.scope, { streamId: owner.streamId });
      streams.delete(streamId);
      return { ...result, streamId };
    },
  };
}
