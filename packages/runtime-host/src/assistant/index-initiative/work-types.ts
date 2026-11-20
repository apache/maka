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

import type { DiscoveryContextMode } from './store.js';

export type DiscoveryLane = 'broad' | 'quick';
type Phase = 'discovery' | 'judgement';
interface ContextWork {
  contextWake?: { id: string; mode: DiscoveryContextMode };
}
interface Submission {
  messageId: string;
  sessionId: string;
  input: string;
  version: string;
}
export interface BroadSubmission extends Submission {
  revision: number;
}
export interface BroadActivation {
  id: string;
  startedAt: number;
  phase: Phase;
  reported?: boolean;
}
export interface BroadDraft {
  id: string;
  phase: Phase;
  submission?: BroadSubmission;
  error?: string;
}
export interface BroadWork extends ContextWork {
  active?: BroadActivation | null;
  pendingDraft?: BroadDraft;
  pendingJudgement?: boolean;
  candidateReport?: { path?: string };
  retry?: { id: string; startedAt: number };
}
export interface QuickSubmission extends Submission {
  capture: string[];
}
export interface QuickReport {
  key: string;
  fingerprint: string;
  messages: string[];
}
export interface QuickActivation {
  id: string;
  startedAt: number;
  from: number;
  to: number;
  tokens: Record<string, string>;
  messageId: string;
  reports: QuickReport[];
  periodic?: boolean;
  retrying?: boolean;
  eventWake?: { ids: string[] };
  wakeInputTokens?: number;
  submission?: QuickSubmission;
  executionCompleted?: boolean;
  delivered?: string[];
}
export interface QuickWork extends ContextWork {
  active?: QuickActivation | null;
  pending?: QuickActivation | null;
}
/** The JSON payload in discovery_jobs.work. Configuration and source receipts live elsewhere. */
export interface DiscoveryWorkByLane {
  broad: BroadWork;
  quick: QuickWork;
}
