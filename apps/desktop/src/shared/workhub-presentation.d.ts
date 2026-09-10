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

export interface WorkHubHostRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkHubHost {
  readonly visible: boolean;
  readonly occluded?: boolean;
  readonly rect: WorkHubHostRect;
}

export interface WorkHubPresentationSnapshot {
  readonly placement: 'docked' | 'floating';
  readonly floatingVisible: boolean;
  readonly shortcutRegistered: boolean;
  readonly rendererCrashed: boolean;
  readonly progressRequest?: number;
}

export type WorkHubMainNavigation =
  | { readonly kind: 'workhub' }
  | { readonly kind: 'session'; readonly sessionKey: string };

export interface WorkHubPresentationBridge {
  ready(): Promise<void>;
  getSnapshot(): Promise<WorkHubPresentationSnapshot>;
  setHost(host: WorkHubHost): Promise<string | void>;
  setConversationLayout(layout: { expanded: boolean; compactHeight: number }): Promise<void>;
  progressReady(request: number): Promise<void>;
  resizeProgress(request: number, height: number): Promise<void>;
  showConversation(progressRequest?: number): Promise<void>;
  detach(): Promise<void>;
  dock(): Promise<void>;
  hide(): Promise<void>;
  openSession(sessionKey: string): Promise<void>;
  subscribe(handler: (snapshot: WorkHubPresentationSnapshot) => void): () => void;
  /** Visible top edge inside the animation canvas, in CSS pixels. */
  onViewportInset(handler: (inset: number) => void): () => void;
  onFocusComposer(handler: (expand?: boolean) => void): () => void;
  onOpenMain(handler: (navigation: WorkHubMainNavigation) => void): () => void;
}
