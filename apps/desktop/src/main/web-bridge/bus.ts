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

/**
 * Cycle-free fan-out for main→renderer broadcasts.
 *
 * Every renderer-bound event flows through `safeSendToRenderer`
 * (main-window.ts), which calls `broadcastToWebBridge` after the Electron
 * delivery. The bridge server subscribes here and forwards to connected
 * browsers. Kept in its own module so main-window and the bridge server
 * never import each other.
 */

export type WebBroadcastListener = (channel: string, args: unknown[]) => void;

const listeners = new Set<WebBroadcastListener>();

export function addWebBroadcastListener(listener: WebBroadcastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcastToWebBridge(channel: string, ...args: unknown[]): void {
  if (listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(channel, args);
    } catch {
      // One slow/broken subscriber must never break Electron delivery.
    }
  }
}
