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

import type { PetMessage, PetSurface } from "../renderer/application/contracts/pet-desktop.js";

/** Replay/reconnect is not a new notification. Never discard queued messages on status refresh. */
export class PetMessageQueue {
  private seen = new Set<string>();
  private owner?: string;
  messages: PetMessage[] = [];
  history: PetMessage[] = [];
  index = 0;
  push(owner: string, messages: PetMessage[]) {
    if (this.owner !== owner) {
      this.clear();
      this.owner = owner;
      this.seen.clear();
      this.history = [];
    }
    for (const message of messages) {
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      this.messages.push(message);
      this.history.push(message);
      if (this.history.length > 50) this.history.shift();
    }
  }
  current() {
    return this.messages[this.index];
  }
  next() {
    if (this.index + 1 < this.messages.length) this.index++;
    else this.clear();
  }
  previous() {
    this.index = Math.max(0, this.index - 1);
  }
  clear() {
    this.messages = [];
    this.index = 0;
  }
}

/** Automatic arrivals expire; explicitly opened messages stay until dismissed. */
export class PetBubbleView {
  mode: 'auto' | 'messages' | 'hidden' = 'auto';
  index = 0;
  unread = false;
  constructor(readonly queue: PetMessageQueue) {}
  get unreadCount() { return this.unread ? this.queue.messages.length : 0; }
  get unreadLabel() { return this.unreadCount > 99 ? "99+" : String(this.unreadCount); }
  message() {
    return this.mode === 'hidden' ? undefined : this.mode === 'messages'
      ? this.queue.history[this.index] : this.queue.current();
  }
  cycle() {
    if (this.mode === 'messages' || this.message()) {
      this.mode = 'auto';
      this.queue.clear();
    } else {
      this.mode = 'messages';
      this.index = Math.max(0, this.queue.history.length - 1);
      this.unread = false;
    }
  }
  toggleVisibility() {
    if (this.mode === 'hidden') this.restore();
    else {
      this.mode = 'hidden';
      // Keep pending arrivals so hiding a message does not lose the unread batch.
      this.unread = !!this.queue.current();
    }
  }
  restore() {
    if (this.unread && this.queue.history.length) {
      // Open this batch once, from its first unseen message. Closing it must
      // leave a route back to status rather than replaying the same badge.
      const first = this.queue.current()?.id;
      this.index = Math.max(0, this.queue.history.findIndex(message => message.id === first));
      this.mode = 'messages';
    } else {
      this.mode = 'auto';
    }
    this.unread = false;
    this.queue.clear();
  }
  arrival() { if (this.mode === 'hidden') this.unread = true; }
  next() {
    if (this.mode === 'messages') this.index = Math.min(this.index + 1, this.queue.history.length - 1);
    else this.queue.next();
  }
  previous() {
    if (this.mode === 'messages') this.index = Math.max(0, this.index - 1);
    else this.queue.previous();
  }
  reset() { this.mode = 'auto'; this.index = 0; this.unread = false; this.queue.history = []; }
}

export function petMessageText(message: PetMessage): string {
  return (message.summary?.trim() || message.text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "〔图片〕")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}

/** Visible text only. Allow 2s to notice the bubble, then ~220ms/character.
 * Chan & Lee (2005) measured 213ms/character for Chinese screen comprehension
 * ("Effect of display factors on Chinese reading times"). This is a UI estimate.
 * Keep the existing 4–20s bounds; hover/focus pauses longer reading.
 */
export function petMessageDuration(message: PetMessage): number {
  return Math.max(4000, Math.min(20000, 2000 + Array.from(petMessageText(message).replace(/\s/g, "")).length * 220));
}

export function shouldClosePetComposer(text: string, idleMs: number, sending: boolean, composing: boolean) {
  return !text.trim() && idleMs >= 5000 && !sending && !composing;
}

/** Short-lived presentation, not a model message or a new assistant conversation. */
export class PetBackgroundNotice {
  private previous?: PetSurface;
  private notice?: { text: string; until: number; title: string };
  reset() { this.previous = undefined; this.notice = undefined; }
  update(surface: PetSurface, now: number) {
    const old = this.previous;
    if (old && old.sessionId === surface.sessionId) {
      const run = surface.discoveryRun, before = old.discoveryRun;
      if (run && !run.running && (before?.running || before?.id !== run.id)) {
        this.notice = run.outcome === 'quiet' || run.outcome === 'reported'
          ? { text: run.outcome === 'quiet' ? '这次没发现有趣的事' : '发现了新线索', title: '主动发现', until: now + 6000 }
          : undefined;
      }
      const prior = old.maintenance?.filter(m => m.running) ?? [];
      const after = surface.maintenance;
      if (prior.length && after && !after.some(m => m.running)) {
        const failed = after.some(m => m.error);
        this.notice = failed ? undefined : { text: '本轮整理完成', title: '记忆维护', until: now + 6000 };
      }
    }
    this.previous = surface;
  }
  read(surface: PetSurface, now: number) {
    if (this.notice && now < this.notice.until) return this.notice;
    if (surface.discoveryRun?.running) return { text: '正在后台探索新线索', title: '主动发现' };
    if (surface.maintenance?.some(m => m.running)) return { text: '正在后台整理记忆', title: '记忆维护' };
    return undefined;
  }
}
