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

/** Durable follow-ups. The body is agent-maintained working state, not a plan schema. */
export const MATTER_STATE_MAX_BYTES = 24 * 1024;
export const MATTER_REQUEST_MAX_LENGTH = 8000;
export const MATTER_SESSION_LABEL = 'matter';

export type MatterStatus = 'active' | 'waiting' | 'paused' | 'completed' | 'cancelled';
export type MatterWake = { kind: 'at'; at: number };
export interface MatterFileContext {
  matterId: string;
  activationId: string;
  revision: number;
  status: MatterStatus;
  now: number;
  timezone: string;
  createdAt: number;
  activationStartedAt: number;
  wake: { causes: string[]; previousRunEndedAt: number | null };
  pendingEventCount: number;
  files: {
    request: string;
    state: string;
    changes: string;
    inbox: string;
    draft: string;
  };
}
export interface MatterEvent {
  id: string;
  matterId: string;
  sequence: number;
  source: string;
  subject: string;
  text: string;
  createdAt: number;
}
export interface MatterActivation {
  id: string;
  turnId: string;
  eventCursor: number;
  startedAt: number;
  settled: boolean;
}
export interface Matter {
  id: string;
  sessionId: string;
  title: string;
  request: string;
  stateText: string;
  revision: number;
  status: MatterStatus;
  wakes: MatterWake[];
  activation: MatterActivation | null;
  runCount: number;
  maxRuns: number;
  consecutiveContinuations: number;
  lastError: string | null;
  lastUpdate: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MatterSnapshot {
  matter: Matter;
  events: MatterEvent[];
  /** Events are a bounded prefix; the complete notebook is always included. */
  pendingEventCount: number;
}
export interface MatterCreateInput {
  title: string;
  request: string;
  sessionId: string;
  maxRuns?: number;
}
export interface MatterSettleInput {
  expectedRevision: number;
  stateText: string;
  disposition: 'continue' | 'wait' | 'complete';
  wakes?: MatterWake[];
  reason: string;
  /** Agent-authored account of this activation, appended to history by the host. */
  summary: string;
  next?: string;
  update?: string;
}
export interface MatterUpdate {
  id: string;
  matterId: string;
  text: string;
  createdAt: number;
  delivered: boolean;
}
export interface MatterRun {
  id: string;
  matterId: string;
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
}

/** A single transaction owns state, event acknowledgement, wakes and updates. */
export interface MatterStore {
  handoff(id: string): { summary: string; reason: string; next?: string; at: number } | null;
  workspace(id: string, activationId: string): MatterFileContext;
  readDraft(id: string, activationId: string, path: string): string;
  readFile(
    id: string,
    activationId: string,
    path: string,
  ): { path: string; content: string; observedAt: number };
  writeDraft(id: string, activationId: string, path: string, content: string): void;
  create(input: MatterCreateInput): Matter;
  list(): Matter[];
  get(id: string): MatterSnapshot;
  forSession(sessionId: string): Matter | undefined;
  ingest(
    id: string,
    input: { key: string; source: string; subject?: string; text: string },
  ): boolean;
  enqueueDue(): void;
  claim(id: string): MatterSnapshot | null;
  assertActive(id: string, activationId: string): Matter;
  observe(id: string, activationId: string): MatterSnapshot;
  checkpoint(
    id: string,
    activationId: string,
    revision: number,
    text: string,
    operationId: string,
  ): Matter;
  settle(id: string, activationId: string, input: MatterSettleInput, operationId: string): Matter;
  finish(id: string, activationId: string, error?: string): void;
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'check'): Matter;
  edit(id: string, revision: number, stateText: string): Matter;
  recover(): void;
  updates(id?: string): MatterUpdate[];
  markDelivered(id: string): void;
  runs(id: string): MatterRun[];
  bindTurn(id: string, activationId: string, turnId: string): Matter;
  binding(sessionId: string, cwd?: string): string | undefined;
  lease(owner: string, until: number): boolean;
  releaseLease(owner: string): void;
  close(): void;
}

export interface MatterBridge {
  list(): Promise<Matter[]>;
  get(id: string): Promise<MatterSnapshot>;
  create(input: { title: string; request: string }): Promise<Matter>;
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'check'): Promise<Matter>;
  message(id: string, text: string): Promise<void>;
  edit(id: string, revision: number, stateText: string): Promise<Matter>;
  runs(id: string): Promise<MatterRun[]>;
  updates(id: string): Promise<MatterUpdate[]>;
  subscribeChanges(handler: () => void): () => void;
}
