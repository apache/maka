import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { PreToolUseHookInput } from '@maka/core/hooks';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import {
  createHookConfigStore,
  createHookTrustStore,
  createSqliteRuntimeStore,
} from '@maka/storage';
import { ToolRuntime, type MakaTool } from '@maka/runtime/tool-runtime';
import { createHostHookComposition, hashHookDefinition } from '../server/host-hook-composition.js';

describe('Host Hook composition', () => {
  it('invalidates exact-definition trust on the next Turn after an execution change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-host-hooks-'));
    const events: RuntimeEvent[] = [];
    try {
      const config = createHookConfigStore(root);
      const trust = createHookTrustStore(root);
      const firstArgs = ['-e', 'process.stderr.write("denied");process.exit(2)'];
      await config.set({
        version: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  id: 'policy',
                  type: 'command',
                  command: process.execPath,
                  args: firstArgs,
                  timeoutMs: 1_000,
                },
              ],
            },
          ],
        },
      });
      const hash = hashHookDefinition({
        source: 'user',
        projectIdentity: 'user',
        matcher: 'Bash',
        command: process.execPath,
        args: firstArgs,
        timeoutMs: 1_000,
      });
      await trust.trust({
        definitionHash: hash,
        source: 'user',
        projectIdentity: 'user',
        trustedAt: Date.now(),
      });
      const composition = createHostHookComposition({
        stateRoot: root,
        runtimeEvents: {
          appendRuntimeEvent: async (_sessionId, _runId, event) => {
            events.push(event);
          },
        },
      });
      const dispatcher = composition.dispatcherFor(header(root));
      const first = await dispatcher.runPreToolUse(
        hookInput('turn-1', 'run-1', root),
        new AbortController().signal,
        { invocationId: 'invocation-1' },
      );
      assert.equal(first.denied, true);
      assert.equal(first.audits[0]?.definitionHash, hash);
      assert.equal(events[0]?.actions?.hookCompleted?.status, 'denied');

      await config.set({
        version: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  id: 'policy',
                  type: 'command',
                  command: process.execPath,
                  args: ['-e', 'process.exit(0)'],
                  timeoutMs: 1_000,
                },
              ],
            },
          ],
        },
      });
      const second = await dispatcher.runPreToolUse(
        hookInput('turn-2', 'run-2', root),
        new AbortController().signal,
        { invocationId: 'invocation-2' },
      );
      assert.equal(second.denied, false);
      assert.equal(second.audits[0]?.status, 'skipped_untrusted');
      assert.notEqual(second.audits[0]?.definitionHash, hash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('denies a real configured and trusted command before ToolRuntime T1 and side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-host-hook-e2e-'));
    const runtimeStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const args = [
        '-e',
        `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const x=JSON.parse(s);if(x.schema_version===1&&x.tool_name==='Bash'&&x.tool_input.command==='git push'){process.stderr.write('push blocked by fixture');process.exit(2)}process.exit(9)})`,
      ];
      const config = createHookConfigStore(root);
      await config.set({
        version: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  id: 'push-policy',
                  type: 'command',
                  command: process.execPath,
                  args,
                  timeoutMs: 1_000,
                },
              ],
            },
          ],
        },
      });
      const definitionHash = hashHookDefinition({
        source: 'user',
        projectIdentity: 'user',
        matcher: 'Bash',
        command: process.execPath,
        args,
        timeoutMs: 1_000,
      });
      await createHookTrustStore(root).trust({
        definitionHash,
        source: 'user',
        projectIdentity: 'user',
        trustedAt: Date.now(),
      });

      const sessionHeader = header(root);
      const dispatcher = createHostHookComposition({
        stateRoot: root,
        runtimeEvents: runtimeStore,
      }).dispatcherFor(sessionHeader);
      let implementationCalls = 0;
      let id = 0;
      let now = 0;
      const runtime = new ToolRuntime({
        sessionId: 'session-1',
        header: sessionHeader,
        connection: {
          slug: 'connection-1',
          providerType: 'openai',
          defaultModel: 'model-1',
        },
        modelId: 'model-1',
        appendMessage: async () => {},
        readExecutionBoundary: async () => createExternalExecutionBoundary(),
        newId: () => `id-${++id}`,
        now: () => ++now,
        getPermissionPauseTarget: () => null,
        turnId: 'turn-1',
        runId: 'run-1',
        invocationId: 'invocation-1',
        runtimeCommitSink: runtimeStore,
        preToolUseHooks: dispatcher,
      });
      const tool: MakaTool<{ command: string }, string> = {
        name: 'Bash',
        description: 'fixture',
        parameters: { type: 'object' },
        impl: async () => {
          implementationCalls += 1;
          return 'should not run';
        },
      };
      const sessionEvents: SessionEvent[] = [];
      const settlement = await runtime.settleToolCall({
        tool,
        turnId: 'turn-1',
        toolCallId: 'provider-call-1',
        input: { command: 'git push' },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: (event) => sessionEvents.push(event),
          pushAndWaitUntilConsumed: async (event) => {
            sessionEvents.push(event);
          },
        },
      });

      assert.equal(implementationCalls, 0);
      assert.match(JSON.stringify(settlement.result), /push blocked by fixture/u);
      const toolStart = sessionEvents.find((event) => event.type === 'tool_start');
      assert.ok(toolStart && toolStart.type === 'tool_start');
      assert.equal(toolStart.operationId, undefined);
      assert.equal(sessionEvents.filter((event) => event.type === 'tool_result').length, 1);

      const runtimeEvents = await runtimeStore.readImmutableRuntimeEvents('session-1', 'run-1');
      assert.equal(runtimeEvents.length, 1);
      assert.equal(runtimeEvents[0]?.actions?.hookCompleted?.status, 'denied');
      assert.equal(runtimeEvents[0]?.actions?.hookCompleted?.definitionHash, definitionHash);
      assert.equal(runtimeEvents[0]?.content, undefined);
    } finally {
      runtimeStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function hookInput(turnId: string, runId: string, cwd: string): PreToolUseHookInput {
  return {
    schema_version: 1,
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    turn_id: turnId,
    run_id: runId,
    tool_use_id: `tool-${turnId}`,
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    cwd,
    permission_mode: 'ask',
    origin: 'provider',
  };
}

function header(root: string): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: root,
    cwd: root,
    projectId: null,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Hook test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    connectionId: 'connection-1',
    modelId: 'model-1',
    thinkingLevel: 'medium',
  } as unknown as SessionHeader;
}
