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

/** Provider-independent contract. Credentials, wire formats and task-call translation belong to the adapter. */
export interface WorkHubVoiceProviderOptions {
  submit(text: string, id?: string, displayText?: string, kind?: 'delegation', userTurnId?: string): Promise<{ status: 'accepted' | 'rejected'; turnId?: string; reason?: string }>;
  /** Emit normalized turn/control events, never provider-specific payloads. */
  observe(event: Record<string, unknown>): void;
  record(kind: string, data: Record<string, unknown>): void;
  onClose(): void;
  onError(message: string): void;
}

export interface WorkHubVoiceSession {
  connect(sdp: string): Promise<string>;
  /** Raw WebRTC data-channel input; normalize it before calling observe. */
  accept(event: Record<string, unknown>): void;
  sendSpeech(text: string, deliveryId: string): Promise<void>;
  sendReply(text: string, requestId: string, deliveryId: string): Promise<void>;
  close(): void;
}

export interface WorkHubVoiceProvider {
  id: string;
  /** Data-channel label negotiated by the provider, not hard-coded by the UI. */
  dataChannelLabel: string;
  create(options: WorkHubVoiceProviderOptions): WorkHubVoiceSession;
}

let installed: WorkHubVoiceProvider | undefined;

/** Trusted desktop composition hook for a future provider plugin. No provider ships by default. */
export function registerWorkHubVoiceProvider(provider: WorkHubVoiceProvider): () => void {
  if (!provider.id.trim() || !provider.dataChannelLabel.trim()) throw new Error('Invalid voice provider');
  if (installed) throw new Error('A voice provider is already registered');
  installed = provider;
  return () => { if (installed === provider) installed = undefined; };
}

export function getWorkHubVoiceProvider(): WorkHubVoiceProvider | undefined { return installed; }
