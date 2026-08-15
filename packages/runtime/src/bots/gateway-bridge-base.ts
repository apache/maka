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
   * Build the identify `d` payload (auth + intents). Return null to
   * skip the send entirely — QQ does this when its token refresh fails.
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

  private onHello(d: { heartbeat_interval: number }): void {
    this.heartbeatInterval = d.heartbeat_interval;
    this.heartbeatAcked = true;
    // Jitter the initial heartbeat per platform recommendation so a
    // fleet of bots does not synchronize their pings.
    this.scheduleHeartbeat(Math.random() * d.heartbeat_interval);
    if (this.sessionId && this.seq !== null) {
      void this.sendResume();
    } else {
      void this.sendIdentify();
    }
  }

  private async sendIdentify(): Promise<void> {
    const d = await this.buildIdentifyPayload();
    if (d !== null) this.sendWs({ op: OP_IDENTIFY, d });
  }

  private async sendResume(): Promise<void> {
    const d = await this.buildResumePayload();
    if (d !== null) this.sendWs({ op: OP_RESUME, d });
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
    const initial = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
      this.heartbeatTimer.unref?.();
    }, initialDelay);
    initial.unref?.();
  }

  protected clearHeartbeat(): void {
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
