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
 * Discord/QQ-shaped gateway protocol on top of {@link WsBridgeBase}:
 * opcode dispatch (HELLO / HEARTBEAT / DISPATCH / RECONNECT /
 * INVALID_SESSION / HEARTBEAT_ACK), heartbeat scheduling with
 * missed-ack reconnect, seq/session tracking, and the identify/resume
 * fork at HELLO. QQ and Discord share these opcodes and this exact
 * lifecycle verbatim; they differ only in the hooks below:
 *   - `fetchGatewayUrl()`      — REST call that yields the WS url
 *   - `buildIdentifyPayload()` / `buildResumePayload()` — auth shapes
 *   - `onDispatch()`           — platform event names and payload mapping
 *
 * DingTalk's Stream protocol has none of this machinery and extends
 * WsBridgeBase directly instead.
 */

import { WsBridgeBase } from './ws-bridge-base.js';

// Discord/QQ gateway opcodes (identical values on both platforms).
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export abstract class GatewayBridgeBase extends WsBridgeBase {
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected heartbeatInitialTimer: NodeJS.Timeout | null = null;
  protected heartbeatInterval = 41_250;
  protected heartbeatAcked = true;
  protected seq: number | null = null;
  protected sessionId: string | null = null;

  /**
   * Resolve the gateway WS url (token refresh + REST gateway fetch).
   * Record the failure reason/emit status itself, then return null —
   * the caller schedules the reconnect.
   */
  protected abstract fetchGatewayUrl(): Promise<string | null>;
  /**
   * Build the identify `d` payload (auth + intents). Return null when
   * auth is unavailable (QQ's token refresh failing) — the base then
   * force-reconnects so the backoff path owns the retry instead of
   * leaving an un-identified socket open.
   */
  protected abstract buildIdentifyPayload():
    | Record<string, unknown>
    | null
    | Promise<Record<string, unknown> | null>;
  protected abstract buildResumePayload():
    | Record<string, unknown>
    | null
    | Promise<Record<string, unknown> | null>;
  protected abstract onDispatch(type: string, d: unknown): void;

  protected override async openConnection(): Promise<void> {
    const url = await this.fetchGatewayUrl();
    if (!url) {
      this.scheduleReconnect();
      return;
    }
    this.connect(url);
  }

  protected override handleWsMessage(data: string): void {
    let payload: { op?: number; s?: number | null; t?: string; d?: unknown };
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case OP_HELLO:
        this.onHello(payload.d as { heartbeat_interval: number });
        break;
      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case OP_DISPATCH:
        this.onDispatch(payload.t ?? '', payload.d);
        break;
      case OP_HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP_RECONNECT:
        this.forceReconnect(true);
        break;
      case OP_INVALID_SESSION:
        this.forceReconnect(payload.d === true);
        break;
    }
  }

  private onHello(d: { heartbeat_interval: number } | null | undefined): void {
    // A malformed HELLO (missing d / heartbeat_interval) must not
    // schedule on NaN — setTimeout(NaN) fires immediately and
    // setInterval(NaN) degrades to a ~1ms heartbeat loop.
    const interval = d?.heartbeat_interval;
    if (typeof interval === 'number' && interval > 0) this.heartbeatInterval = interval;
    this.heartbeatAcked = true;
    // Jitter the initial heartbeat per platform recommendation so a
    // fleet of bots does not synchronize their pings.
    this.scheduleHeartbeat(Math.random() * this.heartbeatInterval);
    if (this.sessionId && this.seq !== null) {
      void this.sendResume();
    } else {
      void this.sendIdentify();
    }
  }

  private async sendIdentify(): Promise<void> {
    const d = await this.buildIdentifyPayload();
    if (d === null) {
      // Auth unavailable — drop the socket instead of idling until
      // the remote gateway gives up on us.
      this.forceReconnect(false);
      return;
    }
    this.sendWs({ op: OP_IDENTIFY, d });
  }

  private async sendResume(): Promise<void> {
    const d = await this.buildResumePayload();
    if (d === null) {
      this.forceReconnect(true);
      return;
    }
    this.sendWs({ op: OP_RESUME, d });
  }

  protected sendHeartbeat(): void {
    if (!this.ws) return;
    if (!this.heartbeatAcked) {
      // Missed ack — the gateway docs say reconnect immediately.
      this.forceReconnect(true);
      return;
    }
    this.heartbeatAcked = false;
    this.sendWs({ op: OP_HEARTBEAT, d: this.seq });
  }

  private scheduleHeartbeat(initialDelay: number): void {
    this.clearHeartbeat();
    this.heartbeatInitialTimer = setTimeout(() => {
      this.heartbeatInitialTimer = null;
      this.sendHeartbeat();
      // The socket may have died between scheduling and firing; do
      // not spin up an interval nothing will clear.
      if (!this.ws) return;
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
      this.heartbeatTimer.unref?.();
    }, initialDelay);
    this.heartbeatInitialTimer.unref?.();
  }

  protected clearHeartbeat(): void {
    if (this.heartbeatInitialTimer) {
      clearTimeout(this.heartbeatInitialTimer);
      this.heartbeatInitialTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  protected forceReconnect(resumable: boolean): void {
    if (!resumable) {
      this.resetSession();
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* swallow */
      }
      this.ws = null;
    }
    this.clearHeartbeat();
    this.scheduleReconnect();
  }

  /** READY / RESUMED share this promotion; call after setting identity/session. */
  protected promoteToOperational(): void {
    this.readiness = 'operational';
    this.reason = undefined;
    this.reconnectAttempts = 0;
    this.emitStatusChange();
  }

  protected override clearProtocolTimers(): void {
    this.clearHeartbeat();
  }

  protected override resetSession(): void {
    this.sessionId = null;
    this.seq = null;
  }
}
