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

import type { AttachmentRef, MessageContent } from '@maka/core/events';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import {
  isUserVisibleSessionSystemNote,
  type AssistantThinking,
  type StoredMessage,
  userFacingText,
} from '@maka/core/session';

/** Removes model-only composition while preserving what the user actually sent. */
export function projectSharedSessionMessageContent(
  content: MessageContent,
  sessionId: string,
): MessageContent {
  const attachments = content.attachments?.filter((attachment) =>
    isSharedSessionAttachment(attachment, sessionId),
  );
  return {
    text: userFacingText(content),
    ...(attachments === undefined ? {} : { attachments: structuredClone(attachments) }),
    ...(content.quotes === undefined ? {} : { quotes: structuredClone(content.quotes) }),
    ...(content.inlineReferences === undefined
      ? {}
      : { inlineReferences: structuredClone(content.inlineReferences) }),
  };
}

/** Projects the canonical transcript fields that the conversation UI can present. */
export function projectSharedSessionTranscriptMessage(
  message: StoredMessage,
  sessionId: string,
): StoredMessage | null {
  switch (message.type) {
    case 'user': {
      return {
        ...projectSharedSessionMessageContent(message, sessionId),
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        ...(message.steeringEventId === undefined
          ? {}
          : { steeringEventId: message.steeringEventId }),
        ...(message.origin === undefined ? {} : { origin: message.origin }),
      };
    }
    case 'assistant':
      return {
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        text: message.text,
        modelId: message.modelId,
        ...(message.thinking === undefined ? {} : { thinking: projectThinking(message.thinking) }),
        ...(message.contentOrder === undefined ? {} : { contentOrder: message.contentOrder }),
      };
    case 'tool_call':
      return {
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        toolName: message.toolName,
        args: projectToolActivityArgs(message.toolName, message.args),
        ...(message.activityKind === undefined ? {} : { activityKind: message.activityKind }),
        ...(message.displayName === undefined ? {} : { displayName: message.displayName }),
        ...(message.intent === undefined ? {} : { intent: message.intent }),
        ...(message.stepId === undefined ? {} : { stepId: message.stepId }),
        ...(message.origin === undefined ? {} : { origin: message.origin }),
        ...(message.modelVisibility === undefined
          ? {}
          : { modelVisibility: message.modelVisibility }),
        ...(message.parentToolCallId === undefined
          ? {}
          : { parentToolCallId: message.parentToolCallId }),
        ...(message.parentOperationId === undefined
          ? {}
          : { parentOperationId: message.parentOperationId }),
      };
    case 'tool_result':
      return {
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        toolUseId: message.toolUseId,
        isError: message.isError,
        content: message.content,
        ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
        ...(message.origin === undefined ? {} : { origin: message.origin }),
        ...(message.modelVisibility === undefined
          ? {}
          : { modelVisibility: message.modelVisibility }),
        ...(message.parentToolCallId === undefined
          ? {}
          : { parentToolCallId: message.parentToolCallId }),
        ...(message.parentOperationId === undefined
          ? {}
          : { parentOperationId: message.parentOperationId }),
      };
    case 'turn_state':
      return {
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        status: message.status,
        ...(message.parentTurnId === undefined ? {} : { parentTurnId: message.parentTurnId }),
        ...(message.retriedFromTurnId === undefined
          ? {}
          : { retriedFromTurnId: message.retriedFromTurnId }),
        ...(message.regeneratedFromTurnId === undefined
          ? {}
          : { regeneratedFromTurnId: message.regeneratedFromTurnId }),
        ...(message.branchOfTurnId === undefined ? {} : { branchOfTurnId: message.branchOfTurnId }),
        ...(message.abortedAt === undefined ? {} : { abortedAt: message.abortedAt }),
        ...(message.abortSource === undefined ? {} : { abortSource: message.abortSource }),
        ...(message.errorClass === undefined ? {} : { errorClass: message.errorClass }),
        partialOutputRetained: message.partialOutputRetained,
      };
    case 'token_usage':
      return {
        type: message.type,
        id: message.id,
        turnId: message.turnId,
        ts: message.ts,
        input: message.input,
        output: message.output,
        ...(message.cacheMissInput === undefined ? {} : { cacheMissInput: message.cacheMissInput }),
        ...(message.cacheRead === undefined ? {} : { cacheRead: message.cacheRead }),
        ...(message.cacheCreation === undefined ? {} : { cacheCreation: message.cacheCreation }),
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
        ...(message.costUsd === undefined ? {} : { costUsd: message.costUsd }),
      };
    case 'system_note':
      return isUserVisibleSessionSystemNote(message.kind)
        ? {
            type: message.type,
            id: message.id,
            ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
            ts: message.ts,
            kind: message.kind,
          }
        : null;
    case 'permission_decision':
    case 'workhub_coordination':
      return null;
  }
}

function isSharedSessionAttachment(attachment: AttachmentRef, sessionId: string): boolean {
  return attachment.ref.kind === 'session_file' && attachment.ref.sessionId === sessionId;
}

function projectThinking(thinking: AssistantThinking): AssistantThinking {
  return {
    text: thinking.text,
    ...(thinking.parts === undefined
      ? {}
      : { parts: thinking.parts.map((part) => ({ text: part.text })) }),
  };
}
