import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkHubCommand, WorkHubCommandResult, WorkHubEvent } from '@maka/core/workhub';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import type { WorkHubOrchestrator } from '../workhub/work-orchestrator.js';
import { decodeWorkHubCommand, registerWorkHubIpc } from '../workhub/workhub-ipc-main.js';

test('decodes the closed WorkHub command surface', () => {
  assert.deepEqual(decodeWorkHubCommand({ kind: 'inspect', ignored: true }), { kind: 'inspect' });
  assert.deepEqual(decodeWorkHubCommand({ kind: 'inspect_metrics' }), { kind: 'inspect_metrics' });
  assert.deepEqual(
    decodeWorkHubCommand({ kind: 'record_metric', metric: 'workhub_opened' }),
    { kind: 'record_metric', metric: 'workhub_opened' },
  );
  assert.throws(
    () => decodeWorkHubCommand({ kind: 'record_metric', metric: 'clarification' }),
    /metric/,
  );
  assert.deepEqual(
    decodeWorkHubCommand({
      kind: 'submit',
      requestId: 'request-1',
      text: ' Continue this Work. ',
      explicitWork: { workspaceId: 'host-1', sessionId: 'session-1' },
      modelSelection: { llmConnectionSlug: ' primary ', model: ' model-a ' },
      attachmentItems: [{ name: ' notes.txt ', mimeType: ' text/plain ', base64: 'aGVsbG8=' }],
    }),
    {
      kind: 'submit',
      requestId: 'request-1',
      text: 'Continue this Work.',
      explicitWork: { workspaceId: 'host-1', sessionId: 'session-1' },
      modelSelection: { llmConnectionSlug: 'primary', model: 'model-a' },
      attachmentItems: [{ name: 'notes.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }],
    },
  );
  assert.throws(
    () => decodeWorkHubCommand({
      kind: 'submit', requestId: 'request-2', text: 'Hello',
      modelSelection: { llmConnectionSlug: '', model: 'model-a' },
    }),
    /model connection/,
  );
  assert.deepEqual(
    decodeWorkHubCommand({ kind: 'stop_coordination', coordinationId: ' coordination-1 ' }),
    { kind: 'stop_coordination', coordinationId: 'coordination-1' },
  );
  assert.deepEqual(
    decodeWorkHubCommand({
      kind: 'resolve_clarification',
      clarificationId: ' clarification-1 ',
      work: { workspaceId: 'host-1', sessionId: 'session-1' },
      modelSelection: { llmConnectionSlug: ' primary ', model: ' model-a ' },
    }),
    {
      kind: 'resolve_clarification',
      clarificationId: 'clarification-1',
      work: { workspaceId: 'host-1', sessionId: 'session-1' },
      modelSelection: { llmConnectionSlug: 'primary', model: 'model-a' },
    },
  );
  assert.deepEqual(
    decodeWorkHubCommand({
      kind: 'correct_route',
      blockId: ' work-1 ',
      work: { workspaceId: 'host-2', sessionId: 'session-2' },
    }),
    {
      kind: 'correct_route',
      blockId: 'work-1',
      work: { workspaceId: 'host-2', sessionId: 'session-2' },
    },
  );
  assert.deepEqual(
    decodeWorkHubCommand({
      kind: 'answer_interaction',
      work: { workspaceId: 'host-1', sessionId: 'session-1' },
      interactionId: 'interaction-1',
      answer: { kind: 'permission', decision: 'allow', rememberForTurn: false },
    }),
    {
      kind: 'answer_interaction',
      work: { workspaceId: 'host-1', sessionId: 'session-1' },
      interactionId: 'interaction-1',
      answer: { kind: 'permission', decision: 'allow', rememberForTurn: false },
    },
  );
  assert.throws(
    () => decodeWorkHubCommand({ kind: 'set_permission', work: {}, mode: 'explore' }),
    /permission mode/,
  );
  assert.throws(() => decodeWorkHubCommand({ kind: 'invented' }), /Unknown/);
});

test('registers one IPC command and projects one event stream', async () => {
  const ipc = new FakeIpcMain();
  const commands: WorkHubCommand[] = [];
  const published: WorkHubEvent[] = [];
  let listener: ((event: WorkHubEvent) => void) | undefined;
  const orchestrator: WorkHubOrchestrator = {
    async handle(command): Promise<WorkHubCommandResult> {
      commands.push(command);
      return { kind: 'snapshot', snapshot: { revision: 0, items: [] } };
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const handle = registerWorkHubIpc({
    ipcMain: ipc,
    orchestrator,
    attachmentApprovals: createAttachmentApprovalRegistry(),
    stat: async () => ({ size: 0 }),
    publish: (event) => published.push(event),
  });

  await ipc.invoke('workhub:handle', { kind: 'inspect' });
  listener?.({ kind: 'snapshot_changed', reason: 'command', snapshot: { revision: 1, items: [] } });
  assert.deepEqual(commands, [{ kind: 'inspect' }]);
  assert.equal(published.length, 1);

  handle.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test('materializes inline attachment payloads before routing them to an explicit Work', async () => {
  const ipc = new FakeIpcMain();
  const commands: WorkHubCommand[] = [];
  const orchestrator: WorkHubOrchestrator = {
    async handle(command): Promise<WorkHubCommandResult> {
      commands.push(command);
      return { kind: 'snapshot', snapshot: { revision: 0, items: [] } };
    },
    subscribe() {
      return () => {};
    },
  };
  const handle = registerWorkHubIpc({
    ipcMain: ipc,
    orchestrator,
    attachmentApprovals: createAttachmentApprovalRegistry(),
    stat: async () => ({ size: 0 }),
    publish: () => {},
  });

  await ipc.invoke('workhub:handle', {
    kind: 'submit',
    requestId: 'request-with-attachment',
    text: 'Summarize this note.',
    explicitWork: { workspaceId: 'host-1', sessionId: 'session-1' },
    attachmentItems: [{ name: 'notes.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }],
  });

  assert.deepEqual(commands, [{
    kind: 'submit',
    requestId: 'request-with-attachment',
    text: 'Summarize this note.',
    explicitWork: { workspaceId: 'host-1', sessionId: 'session-1' },
    attachmentItems: [{ name: 'notes.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }],
  }]);
  handle.dispose();
});

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: any[]) => unknown>();

  handle(channel: string, listener: (...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`Missing handler: ${channel}`);
    return Promise.resolve(listener({ sender: { id: 1 } }, ...args));
  }
}
