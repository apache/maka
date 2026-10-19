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

export interface ComposerStagedContextInput {
  readonly pendingQuotes?: readonly unknown[];
  readonly pendingSessionReferences?: readonly unknown[];
  readonly pendingAttachments?: readonly unknown[];
  readonly allowAttachmentOnlySend?: boolean;
}

export function hasComposerStagedContext(input: ComposerStagedContextInput): boolean {
  return Boolean(
    input.pendingQuotes?.length ||
      input.pendingSessionReferences?.length ||
      (input.allowAttachmentOnlySend && input.pendingAttachments?.length),
  );
}

export interface ComposerSendPolicyInput {
  readonly text: string;
  readonly hasStagedContext: boolean;
  readonly disabled?: boolean;
  readonly sendBlocked?: boolean;
  readonly executorModelPending: boolean;
  readonly sendPending: boolean;
  readonly importActionBusy: boolean;
  readonly noModelConnection: boolean;
  readonly streaming?: boolean;
  /**
   * The Runtime Host's resume planner confirmed the session's latest
   * interrupted Turn can resume right now (#5903). The send slot offers Resume
   * in place of Send only while the draft holds nothing sendable — typing or
   * staging context brings Send back, and a running Turn keeps Stop.
   */
  readonly resumeOffered?: boolean;
}

export interface ComposerSendPolicy {
  readonly hasSendableContent: boolean;
  readonly sendDisabled: boolean;
  readonly stopShown: boolean;
  readonly resumeShown: boolean;
}

export function deriveComposerSendPolicy(input: ComposerSendPolicyInput): ComposerSendPolicy {
  const hasSendableContent = Boolean(input.text.trim() || input.hasStagedContext);
  return {
    hasSendableContent,
    sendDisabled: Boolean(
      input.disabled ||
        input.sendBlocked ||
        input.executorModelPending ||
        input.sendPending ||
        input.importActionBusy ||
        !hasSendableContent ||
        input.noModelConnection,
    ),
    stopShown: Boolean(
      input.streaming && (input.sendBlocked || !hasSendableContent),
    ),
    resumeShown: Boolean(
      input.resumeOffered &&
        !hasSendableContent &&
        !input.streaming &&
        !input.disabled &&
        !input.sendBlocked &&
        !input.sendPending &&
        !input.importActionBusy,
    ),
  };
}
