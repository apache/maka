import type {
  MessageContent,
  SessionEvent,
  StorageRef,
  ToolResultContent,
} from '@maka/core/events';
import type { SessionSummary, TurnRecord } from '@maka/core/session';
import type { DesktopSessionSummary } from './bridge-contract.js';
export type { DesktopSessionSummary } from './bridge-contract.js';
import { desktopSessionKey, type DesktopHostRef } from './runtime-host-identity.js';

export interface DesktopSessionHost extends DesktopHostRef {
  readonly profileId?: string;
  readonly profileName?: string;
  readonly profileKind?: 'local' | 'remote';
}

function projectSessionId(host: DesktopHostRef, sessionId: string): string {
  return desktopSessionKey({ hostId: host.hostId, sessionId });
}

function projectStorageRef(host: DesktopHostRef, ref: StorageRef): StorageRef {
  return ref.kind === 'session_file'
    ? { ...ref, sessionId: projectSessionId(host, ref.sessionId) }
    : ref;
}

function projectMessageContent<T extends MessageContent>(
  host: DesktopHostRef,
  content: T,
): T {
  if (!content.attachments?.some((attachment) => attachment.ref.kind === 'session_file')) {
    return content;
  }
  return {
    ...content,
    attachments: content.attachments.map((attachment) => ({
      ...attachment,
      ref: projectStorageRef(host, attachment.ref),
    })),
  };
}

function projectToolResultContent(
  host: DesktopHostRef,
  content: ToolResultContent,
): ToolResultContent {
  switch (content.kind) {
    case 'image':
      return { ...content, ref: projectStorageRef(host, content.ref) };
    case 'subagent':
      return content.childSessionId
        ? { ...content, childSessionId: projectSessionId(host, content.childSessionId) }
        : content;
    case 'agent_swarm':
      return {
        ...content,
        items: content.items.map((item) =>
          item.childSessionId
            ? { ...item, childSessionId: projectSessionId(host, item.childSessionId) }
            : item,
        ),
      };
    default:
      return content;
  }
}

export function projectDesktopSessionEvent(
  host: DesktopHostRef,
  event: SessionEvent,
): SessionEvent {
  switch (event.type) {
    case 'tool_output_delta':
      return { ...event, sessionId: projectSessionId(host, event.sessionId) };
    case 'tool_result_preview':
      return {
        ...event,
        content: {
          ...event.content,
          childSessionId: projectSessionId(host, event.content.childSessionId),
        },
      };
    case 'tool_result':
      return { ...event, content: projectToolResultContent(host, event.content) };
    case 'steering_message':
      return { ...event, content: projectMessageContent(host, event.content) };
    default:
      return event;
  }
}

export function projectDesktopTurnRecord(
  host: DesktopHostRef,
  turn: TurnRecord,
): TurnRecord {
  return turn.parentSessionId
    ? { ...turn, parentSessionId: projectSessionId(host, turn.parentSessionId) }
    : turn;
}

export function projectDesktopSessionSummary(
  host: DesktopSessionHost,
  session: SessionSummary,
): DesktopSessionSummary {
  const projectRelatedSessionId = (value: string | undefined): string | undefined =>
    value === undefined
      ? undefined
      : projectSessionId(host, value);
  return {
    ...session,
    id: desktopSessionKey({ hostId: host.hostId, sessionId: session.id }),
    ...(session.parentSessionId === undefined
      ? {}
      : { parentSessionId: projectRelatedSessionId(session.parentSessionId) }),
    ...(session.revisionRootSessionId === undefined
      ? {}
      : { revisionRootSessionId: projectRelatedSessionId(session.revisionRootSessionId) }),
    ...(session.revisionParentSessionId === undefined
      ? {}
      : { revisionParentSessionId: projectRelatedSessionId(session.revisionParentSessionId) }),
    ...(session.subagent === undefined
      ? {}
      : {
          subagent: {
            ...session.subagent,
            parentSessionId: projectRelatedSessionId(session.subagent.parentSessionId)!,
          },
        }),
    ...(session.subagentParent === undefined
      ? {}
      : {
          subagentParent: {
            ...session.subagentParent,
            parentSessionId: projectRelatedSessionId(session.subagentParent.parentSessionId)!,
          },
        }),
    runtimeHostId: host.hostId,
    ...(host.profileId ? { profileId: host.profileId } : {}),
    ...(host.profileName ? { profileName: host.profileName } : {}),
    ...(host.profileKind ? { profileKind: host.profileKind } : {}),
  };
}
