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
 * Shared transport lifecycle for outbound-WebSocket bot bridges
 * (Discord / QQ gateway, DingTalk Stream): connect, close policy,
 * reconnect with exponential backoff, stop semantics. Protocol
 * concerns (opcodes, heartbeat, frames) live in subclasses.
 *
 * Everything here was previously duplicated verbatim across the three
 * bridge files; the hooks below are the only per-platform seams:
 *   - `checkCredentials()`    — start() gate, returns a reason string or null
 *   - `openConnection()`      — fetch the WS url (token/gateway handshake) and `connect()`
 *   - `handleWsMessage(data)` — one inbound text frame
 *   - `decideClose()`         — close-code policy (fatal / resumable / stopped)
 *   - `onWsOpen()`            — DingTalk promotes readiness here; gateway
 *                               bridges wait for READY instead
 */

import { WebSocket } from 'undici';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotStatus } from './types.js';

export const RECONNECT_DELAY_MIN_MS = 1_000;
export const RECONNECT_DELAY_MAX_MS = 30_000;

/**
 * Pure helper: compute the next backoff delay given the attempt count.
 * Exponential up to RECONNECT_DELAY_MAX_MS.
 */
export function reconnectBackoffMs(attempts: number): number {
  const exp = Math.min(2 ** attempts, RECONNECT_DELAY_MAX_MS / RECONNECT_DELAY_MIN_MS);
  return Math.min(RECONNECT_DELAY_MIN_MS * exp, RECONNECT_DELAY_MAX_MS);
}

export type WsCloseDecision =
  | { kind: 'stopped' }
  | { kind: 'fatal'; code: number }
  | { kind: 'reconnect'; resumable: boolean };

export abstract class WsBridgeBase extends BaseBotAdapter {
  protected ws: WebSocket | null = null;
  protected explicitlyStopped = false;
  protected reconnectAttempts = 0;
  protected reconnectTimer: NodeJS.Timeout | null = null;

  /** Reason-string prefix for close diagnostics; DingTalk overrides to 'stream'. */
  protected readonly closeReasonPrefix: string = 'gateway';

  protected abstract openConnection(): Promise<void>;
  /** Return a reason string (e.g. 'no-token') to abort start(), or null to proceed. */
  protected abstract checkCredentials(): string | null;
  protected abstract decideClose(code: number, explicitlyStopped: boolean): WsCloseDecision;
  protected abstract handleWsMessage(data: string): void;

  /** Factory seam so tests can substitute a fake socket. */
  protected createWebSocket(url: string): WebSocket {
    return new WebSocket(url);
  }

  protected onWsOpen(): void {
    this.running = true;
    this.startedAt = Date.now();
  }

  /** Clear protocol-owned timers on close/stop; gateway bridges clear heartbeat here. */
  protected clearProtocolTimers(): void {}

  /** Drop resumable session state; gateway bridges clear seq/sessionId here. */
  protected resetSession(): void {}

  override async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    const missingCredentials = this.checkCredentials();
    if (missingCredentials) {
      this.reason = missingCredentials;
      this.readiness = 'scaffolded';
      return;
    }
    this.explicitlyStopped = false;
    await this.openConnection();
  }

  override async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.running = false;
    this.clearProtocolTimers();
    this.clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* swallow */
      }
      this.ws = null;
    }
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  protected connect(url: string): void {
    let ws: WebSocket;
    try {
      ws = this.createWebSocket(url);
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.onWsOpen();
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      const data = event.data;
      this.handleWsMessage(typeof data === 'string' ? data : String(data));
    });
    ws.addEventListener('close', (event: { code: number; reason: string }) => {
      // A socket the bridge already detached (stop/forceReconnect
      // closed it and moved on) must not re-enter the close policy —
      // its late close event would double-schedule the reconnect and
      // could drop a session the intentional reconnect meant to keep.
      if (this.ws !== ws) return;
      this.handleClose(event.code, event.reason);
    });
    ws.addEventListener('error', () => {
      // The `close` event fires immediately after; no separate handling.
    });
  }

  protected sendWs(payload: object): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // Swallow — the close handler will fire if the socket died.
    }
  }

  protected handleClose(code: number, reason: string): void {
    this.clearProtocolTimers();
    this.ws = null;
    this.running = false;
    const decision = this.decideClose(code, this.explicitlyStopped);
    if (decision.kind === 'stopped') return;
    if (decision.kind === 'fatal') {
      this.readiness = 'configured';
      this.reason = `${this.closeReasonPrefix}-closed-${code}`;
      this.resetSession();
      this.emitStatusChange();
      return;
    }
    if (!decision.resumable) {
      this.resetSession();
    }
    this.readiness = 'degraded';
    this.reason = reason || `${this.closeReasonPrefix}-closed-${code}`;
    this.emitStatusChange();
    this.scheduleReconnect();
  }

  protected scheduleReconnect(): void {
    if (this.explicitlyStopped) return;
    this.clearReconnect();
    const delay = reconnectBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  protected clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }
}
