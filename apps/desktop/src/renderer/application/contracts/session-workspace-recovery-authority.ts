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

import { useSyncExternalStore } from 'react';

/**
 * The Session workspace recovery command's shared seam (#5551). Features may
 * not import each other, so Task Entry publishes its picker command here and
 * readers consume it without a shell-drilled prop.
 */
export type SessionWorkspaceRecoveryCommand = (sessionId: string) => void;

let current: SessionWorkspaceRecoveryCommand | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes the command while its owner is mounted; returns the unpublish. */
export function publishSessionWorkspaceRecovery(
  command: SessionWorkspaceRecoveryCommand,
): () => void {
  current = command;
  for (const listener of listeners) listener();
  return () => {
    if (current !== command) return;
    current = undefined;
    for (const listener of listeners) listener();
  };
}

/** The current recovery command, or `undefined` before the owner publishes. */
export function useSessionWorkspaceRecoveryCommand(): SessionWorkspaceRecoveryCommand | undefined {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
