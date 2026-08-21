import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import type { AttachmentIngestItem } from '@maka/core/events';
import { isPermissionMode } from '@maka/core/permission';
import { decodeInteractionAnswer } from '@maka/core/interaction';
import type {
  WorkHubCommand,
  WorkHubEvent,
  WorkHubModelSelection,
  WorkHubWorkRef,
} from '@maka/core/workhub';
import type { WorkHubOrchestrator } from './work-orchestrator.js';
import type { AttachmentApprovalRegistry } from '../attachment-approval.js';
import { readFileCapped, resolveIngestItems } from '../attachment-ingest.js';

interface IpcMainLike {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

export function registerWorkHubIpc(deps: {
  ipcMain: IpcMainLike;
  orchestrator: WorkHubOrchestrator;
  attachmentApprovals: AttachmentApprovalRegistry;
  stat(path: string): Promise<{ size: number }>;
  publish(event: WorkHubEvent): void;
}): { dispose(): void } {
  deps.ipcMain.handle('workhub:handle', async (event, value: unknown) => {
    let command = decodeWorkHubCommand(value);
    if (command.kind === 'submit' && command.attachmentItems?.length) {
      if (!command.explicitWork) throw new Error('WORKHUB_ATTACHMENTS_REQUIRE_TARGET');
      command = {
        ...command,
        attachmentItems: await materializeAttachmentItems({
          senderId: event.sender.id,
          items: command.attachmentItems,
          approvals: deps.attachmentApprovals,
          stat: deps.stat,
        }),
      };
    }
    return deps.orchestrator.handle(command);
  });
  const unsubscribe = deps.orchestrator.subscribe(deps.publish);
  return {
    dispose() {
      unsubscribe();
      deps.ipcMain.removeHandler('workhub:handle');
    },
  };
}

export function decodeWorkHubCommand(value: unknown): WorkHubCommand {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError('Invalid WorkHub command');
  }
  if (value.kind === 'inspect') return { kind: 'inspect' };
  if (value.kind === 'inspect_metrics') return { kind: 'inspect_metrics' };
  if (value.kind === 'record_metric') {
    if (value.metric !== 'workhub_opened' && value.metric !== 'manual_session_switch') {
      throw new TypeError('Invalid WorkHub metric');
    }
    return { kind: 'record_metric', metric: value.metric };
  }
  if (value.kind === 'submit') {
    const requestId = requireString(value.requestId, 'requestId', 512);
    const text = requireString(value.text, 'text', 128_000);
    return {
      kind: 'submit',
      requestId,
      text,
      ...(value.explicitWork === undefined ? {} : { explicitWork: decodeWorkRef(value.explicitWork) }),
      ...(value.modelSelection === undefined
        ? {}
        : { modelSelection: decodeModelSelection(value.modelSelection) }),
      ...(value.attachmentItems === undefined
        ? {}
        : { attachmentItems: decodeAttachmentItems(value.attachmentItems) }),
    };
  }
  if (value.kind === 'set_permission') {
    if (!isPermissionMode(value.mode) || value.mode === 'explore') {
      throw new TypeError('Invalid WorkHub permission mode');
    }
    return { kind: 'set_permission', work: decodeWorkRef(value.work), mode: value.mode };
  }
  if (value.kind === 'answer_interaction') {
    return {
      kind: 'answer_interaction',
      work: decodeWorkRef(value.work),
      interactionId: requireString(value.interactionId, 'interactionId', 512),
      answer: decodeInteractionAnswer(value.answer),
    };
  }
  if (value.kind === 'stop_work') {
    return { kind: 'stop_work', work: decodeWorkRef(value.work) };
  }
  if (value.kind === 'resolve_clarification') {
    return {
      kind: 'resolve_clarification',
      clarificationId: requireString(value.clarificationId, 'clarificationId', 512),
      work: decodeWorkRef(value.work),
      ...(value.modelSelection === undefined
        ? {}
        : { modelSelection: decodeModelSelection(value.modelSelection) }),
    };
  }
  if (value.kind === 'correct_route') {
    return {
      kind: 'correct_route',
      blockId: requireString(value.blockId, 'blockId', 512),
      work: decodeWorkRef(value.work),
    };
  }
  if (value.kind === 'stop_coordination') {
    return {
      kind: 'stop_coordination',
      coordinationId: requireString(value.coordinationId, 'coordinationId', 512),
    };
  }
  throw new TypeError('Unknown WorkHub command');
}

async function materializeAttachmentItems(input: {
  senderId: number;
  items: readonly AttachmentIngestItem[];
  approvals: AttachmentApprovalRegistry;
  stat(path: string): Promise<{ size: number }>;
}): Promise<AttachmentIngestItem[]> {
  const files = await resolveIngestItems({
    senderId: input.senderId,
    items: input.items,
    approvals: input.approvals,
    stat: input.stat,
  });
  return Promise.all(files.map(async (file) => {
    const content = 'path' in file
      ? await readFileCapped(file.path, MAX_ATTACHMENT_BYTES)
      : file.content;
    return {
      name: 'path' in file ? basename(file.path) : file.name,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      base64: Buffer.from(content).toString('base64'),
    };
  }));
}

function decodeAttachmentItems(value: unknown): AttachmentIngestItem[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new TypeError('Invalid WorkHub attachment items');
  }
  const maximumBase64Length = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4;
  return value.map((item) => {
    if (!isRecord(item)) throw new TypeError('Invalid WorkHub attachment item');
    const name = requireString(item.name, 'attachment name', 4_096);
    const mimeType = item.mimeType === undefined
      ? undefined
      : requireString(item.mimeType, 'attachment mime type', 512);
    if (typeof item.approvalId === 'string') {
      return {
        approvalId: requireString(item.approvalId, 'attachment approval', 512),
        name,
        ...(mimeType ? { mimeType } : {}),
      };
    }
    if (typeof item.base64 === 'string' && item.base64.length <= maximumBase64Length) {
      return { name, ...(mimeType ? { mimeType } : {}), base64: item.base64 };
    }
    throw new TypeError('Invalid WorkHub attachment item');
  });
}

function decodeModelSelection(value: unknown): WorkHubModelSelection {
  if (!isRecord(value)) throw new TypeError('Invalid WorkHub model selection');
  return {
    llmConnectionSlug: requireString(value.llmConnectionSlug, 'model connection', 512),
    model: requireString(value.model, 'model', 1024),
  };
}

function decodeWorkRef(value: unknown): WorkHubWorkRef {
  if (!isRecord(value)) throw new TypeError('Invalid WorkHub Work reference');
  return {
    workspaceId: requireString(value.workspaceId, 'workspaceId', 512),
    sessionId: requireString(value.sessionId, 'sessionId', 512),
  };
}

function requireString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid WorkHub ${label}`);
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > maximum) {
    throw new TypeError(`Invalid WorkHub ${label}`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
