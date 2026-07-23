import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import {
  decodeMessageContent as decodeCanonicalMessageContent,
  isCanonicalAttachmentRef,
  type MessageContent,
} from '@maka/core/events';
import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireRecord,
  requireString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export interface TurnStartInput {
  sessionId: string;
  turnId: string;
  content: MessageContent;
}

export type { MessageContent };

export const TURN_MESSAGE_TEXT_MAX_BYTES = 48 * 1024;
export const TURN_MESSAGE_CONTENT_MAX_BYTES = 52 * 1024;
export const TURN_MESSAGE_QUOTE_MAX_COUNT = 16;
export const TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH = 32_000;
export const TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH = 200;
const ATTACHMENT_NAME_MAX_BYTES = 512;
const ATTACHMENT_MIME_TYPE_MAX_BYTES = 256;
const ATTACHMENT_PATH_MAX_BYTES = 4096;

export interface TurnQueryInput {
  sessionId: string;
  turnId: string;
}

export interface TurnStopInput {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnRunStatus =
  | 'admitted'
  | 'created'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TurnSnapshotBase {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnSnapshot =
  | (TurnSnapshotBase & {
      status: Exclude<TurnRunStatus, 'completed' | 'failed' | 'cancelled'>;
    })
  | (TurnSnapshotBase & { status: 'completed'; terminalEventId: string })
  | (TurnSnapshotBase & {
      status: 'failed';
      terminalEventId: string;
      failureClass: string;
    })
  | (TurnSnapshotBase & {
      status: 'cancelled';
      terminalEventId: string;
      abortSource: string;
    });

export const TURN_OPERATION_SPECS = {
  'turn.start': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStartInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnQueryInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.stop': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStopInput,
    decodeOutput: decodeTurnSnapshot,
  }),
} as const;

function decodeTurnStartInput(value: unknown): TurnStartInput {
  const record = requireExactRecord(value, 'turn.start input', ['sessionId', 'turnId', 'content']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    content: decodeMessageContent(record.content),
  };
}

export function decodeMessageContent(value: unknown): MessageContent {
  let content: MessageContent;
  try {
    content = decodeCanonicalMessageContent(value);
  } catch {
    throw invalidProtocolFrame('Invalid Message content');
  }
  requireUtf8String(content.text, 'Message text', TURN_MESSAGE_TEXT_MAX_BYTES, false);
  if (content.displayText !== undefined) {
    requireUtf8String(
      content.displayText,
      'Message displayText',
      TURN_MESSAGE_TEXT_MAX_BYTES,
      true,
    );
  }
  if ((content.attachments?.length ?? 0) > MAX_ATTACHMENT_COUNT) {
    throw invalidProtocolFrame('Invalid Message attachments');
  }
  for (const attachment of content.attachments ?? []) {
    if (!isCanonicalAttachmentRef(attachment)) {
      throw invalidProtocolFrame('Invalid AttachmentRef');
    }
    requireUtf8String(attachment.name, 'AttachmentRef name', ATTACHMENT_NAME_MAX_BYTES, false);
    requireUtf8String(
      attachment.mimeType,
      'AttachmentRef mimeType',
      ATTACHMENT_MIME_TYPE_MAX_BYTES,
      false,
    );
    if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
      throw invalidProtocolFrame('Invalid AttachmentRef bytes');
    }
    if (attachment.ref.kind === 'session_file') {
      requireEntityId(attachment.ref.sessionId, 'AttachmentRef sessionId');
    }
    const path =
      attachment.ref.kind === 'external_file'
        ? attachment.ref.absolutePath
        : attachment.ref.relativePath;
    requireUtf8String(path, 'AttachmentRef path', ATTACHMENT_PATH_MAX_BYTES, false);
  }
  if ((content.quotes?.length ?? 0) > TURN_MESSAGE_QUOTE_MAX_COUNT) {
    throw invalidProtocolFrame('Invalid Message quotes');
  }
  for (const quote of content.quotes ?? []) {
    requireString(quote.text, 'QuoteRef text', TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH);
    if (quote.label !== undefined) {
      requireString(quote.label, 'QuoteRef label', TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH);
    }
    if (quote.sourceTurnId !== undefined) {
      requireEntityId(quote.sourceTurnId, 'QuoteRef sourceTurnId');
    }
  }
  requireEncodedByteLimit(content, 'Message content', TURN_MESSAGE_CONTENT_MAX_BYTES);
  return content;
}

function requireUtf8String(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireEncodedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}

function decodeTurnQueryInput(value: unknown): TurnQueryInput {
  const record = requireExactRecord(value, 'turn.query input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnStopInput(value: unknown): TurnStopInput {
  const record = requireExactRecord(value, 'turn.stop input', ['sessionId', 'turnId', 'runId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

export function decodeTurnSnapshot(value: unknown): TurnSnapshot {
  const record = requireRecord(value, 'Turn snapshot');
  const base = {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
  const status = requireTurnRunStatus(record.status);
  if (status === 'completed') {
    assertExactKeys(record, 'completed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
    };
  }
  if (status === 'failed') {
    assertExactKeys(record, 'failed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'failureClass',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      failureClass: requireString(record.failureClass, 'failureClass', 128),
    };
  }
  if (status === 'cancelled') {
    assertExactKeys(record, 'cancelled Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'abortSource',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      abortSource: requireString(record.abortSource, 'abortSource', 128),
    };
  }
  assertExactKeys(record, 'non-terminal Turn snapshot', ['sessionId', 'turnId', 'runId', 'status']);
  return { ...base, status };
}

function requireTurnRunStatus(value: unknown): TurnRunStatus {
  if (
    value === 'admitted' ||
    value === 'created' ||
    value === 'running' ||
    value === 'waiting_for_user' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Turn run status');
}
