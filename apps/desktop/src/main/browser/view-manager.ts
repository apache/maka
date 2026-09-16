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
 * Per-conversation lifecycle for embedded-browser views. One view per
 * conversation, lazily created on first use (navigate or automation) and torn
 * down when the conversation is deleted/archived or the app quits.
 *
 * Deliberately electron-free: it maps sessionId → controller and delegates the
 * real view create/destroy to an injected factory (the electron-backed
 * BrowserViewController lives in controller.ts, wired only in main.ts). That
 * keeps the bookkeeping — including the leak invariant — unit-testable with a
 * stub controller.
 */

/** The slice of a controller the manager itself drives; tests pass a stub. */
export interface ManagedView {
  state(): { hasPage: boolean; url: string };
  dispose(): Promise<void>;
}

export interface BrowserViewManagerDeps<C extends ManagedView> {
  /** Create a real view for `sessionId`. Called at most once per id. */
  create: (sessionId: string) => C;
  /**
   * Notified with the live session-id set whenever a view is created or
   * disposed, so the renderer can show/hide its browser panel. Never fired on
   * reuse — only on a real create/destroy.
   */
  onLiveChange?: (liveSessionIds: string[]) => void;
}

export class BrowserViewManager<C extends ManagedView> {
  private readonly views = new Map<string, C>();

  constructor(private readonly deps: BrowserViewManagerDeps<C>) {}

  /** Lazily create (or reuse) the view for `sessionId`. */
  getOrCreate(sessionId: string): C {
    let view = this.views.get(sessionId);
    if (!view) {
      view = this.deps.create(sessionId);
      this.views.set(sessionId, view);
      this.notifyLiveChange();
    }
    return view;
  }

  get(sessionId: string): C | undefined {
    return this.views.get(sessionId);
  }

  /** Tear down one session's view. No-op if it was never created. */
  async dispose(sessionId: string): Promise<void> {
    const view = this.views.get(sessionId);
    if (!view) return;
    // Drop from the map first so a concurrent getOrCreate makes a fresh view
    // rather than handing back the one being destroyed.
    this.views.delete(sessionId);
    this.notifyLiveChange();
    await view.dispose();
  }

  /** Tear down every view (app quit). */
  async disposeAll(): Promise<void> {
    const ids = [...this.views.keys()];
    await Promise.all(ids.map((id) => this.dispose(id)));
  }

  /** Snapshot the owned identities for an external lifecycle boundary. */
  sessionIds(): string[] {
    return [...this.views.keys()];
  }

  /** Live view count — asserts the leak invariant in tests. */
  liveCount(): number {
    return this.views.size;
  }

  private notifyLiveChange(): void {
    this.deps.onLiveChange?.([...this.views.keys()]);
  }
}
