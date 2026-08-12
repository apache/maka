import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { PreToolUseHookInput } from '@maka/core/hooks';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import { createHookConfigStore, createHookTrustStore } from '@maka/storage';
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
