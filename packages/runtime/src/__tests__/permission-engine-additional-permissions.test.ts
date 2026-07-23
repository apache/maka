import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { HostedInteractionBridge } from '@maka/core/backend-types';
import type { PermissionResponse } from '@maka/core/permission';

import {
  DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
  AdditionalPermissionError,
  buildAdditionalPermissionProposal,
  type AdditionalPermissionProposal,
} from '../additional-permissions.js';
import { PermissionEngine } from '../permission-engine.js';

function createFixture(): {
  engine: PermissionEngine;
  setNow(value: number): void;
} {
  let id = 0;
  let now = 100;
  return {
    engine: new PermissionEngine({
      newId: () => `id-${++id}`,
      now: () => now,
    }),
    setNow: (value) => {
      now = value;
    },
  };
}

function createNetworkProposal(input: {
  toolName: string;
  args: unknown;
}): AdditionalPermissionProposal {
  return buildAdditionalPermissionProposal({
    profile: { network: { enabled: true } },
    normalizedPaths: [],
    justification: 'Allow network access for this call.',
    toolName: input.toolName,
    args: input.args,
    workspaceRoots: ['/workspace'],
  });
}

function hostedInteraction(turnId = 'turn-1'): HostedInteractionBridge {
  return {
    sessionId: 'session-1',
    turnId,
    runId: 'run-1',
    admitPermissionRequest: async () => ({ state: 'pending' }),
    commitPermissionAnswer: async () => {},
    commitPermissionTimeout: async () => {},
    admitUserQuestionRequest: async () => {},
  };
}

describe('PermissionEngine one-shot additional permission requests', () => {
  test('prompts for additional permissions even when execute mode allows the base tool', () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const proposal = createNetworkProposal({ toolName: 'Write', args });

    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });

    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    assert.equal(verdict.event.kind, 'additional_permissions');
    if (verdict.event.kind !== 'additional_permissions') {
      assert.fail('expected an additional permission request');
    }
    assert.equal(verdict.event.reason, 'additional_permissions');
    assert.equal(verdict.event.args, undefined);
    assert.equal(verdict.event.permissionsHash, proposal.permissionsHash);
    assert.equal(verdict.event.alsoApprovesToolExecution, false);
    assert.deepEqual(verdict.event.availableDecisions, ['allow_once', 'deny']);
  });

  test('one additional approval can also approve the base ask-mode tool call', () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'ask',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args }),
    });

    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind === 'prompt') {
      if (verdict.event.kind !== 'additional_permissions') {
        assert.fail('expected an additional permission request');
      }
      assert.equal(verdict.event.alsoApprovesToolExecution, true);
      assert.equal(engine.pendingCount('turn-1'), 1);
    }
  });

  test('does not expose a remembered tool scope on a hosted one-shot request', async () => {
    const { engine } = createFixture();
    const bridge = hostedInteraction();
    const args = { command: 'curl https://example.test' };
    const evaluateToolPermission = (toolUseId: string) =>
      engine.evaluate({
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        hostedInteraction: bridge,
        toolUseId,
        toolName: 'Bash',
        args,
        mode: 'ask',
        cwd: '/workspace',
      });

    const first = evaluateToolPermission('tool-1');
    assert.equal(first.kind, 'prompt');
    if (first.kind !== 'prompt') return;
    assert.equal(first.event.kind, 'tool_permission');
    assert.ok(first.rememberScopeId);
    assert.ok(first.settlement);
    await first.settlement.applyAnswer({ decision: 'allow', rememberForTurn: true });
    await first.parked;

    const sibling = evaluateToolPermission('tool-2');
    assert.equal(sibling.kind, 'prompt');
    if (sibling.kind !== 'prompt') return;
    assert.equal(sibling.event.kind, 'tool_permission');
    assert.equal(sibling.rememberScopeId, first.rememberScopeId);
    assert.ok(sibling.settlement);
    await sibling.settlement.applyAnswer({ decision: 'deny' });
    await sibling.parked;

    const oneShot = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      hostedInteraction: bridge,
      toolUseId: 'tool-3',
      toolName: 'Bash',
      args,
      mode: 'ask',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Bash', args }),
    });
    assert.equal(oneShot.kind, 'prompt');
    if (oneShot.kind !== 'prompt') return;
    assert.equal(oneShot.event.kind, 'additional_permissions');
    assert.equal(oneShot.rememberScopeId, undefined);
  });

  test('an explicit tool allow does not bypass the additional permission request', () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'ask',
      cwd: '/workspace',
      permissionRules: [{ effect: 'allow', kind: 'tool', toolName: 'Write' }],
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args }),
    });

    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind === 'prompt') {
      if (verdict.event.kind !== 'additional_permissions') {
        assert.fail('expected an additional permission request');
      }
      assert.equal(verdict.event.alsoApprovesToolExecution, false);
    }
  });

  test('blocks tampered, explore-mode, and explicitly denied proposals', () => {
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const proposal = createNetworkProposal({ toolName: 'Write', args });

    const tampered = createFixture().engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: {
        ...proposal,
        permissionsHash: `sha256:${'0'.repeat(64)}`,
      },
    });
    assert.equal(tampered.kind, 'block');

    const explore = createFixture().engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'explore',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(explore.kind, 'block');

    const denied = createFixture().engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      permissionRules: [{ effect: 'deny', kind: 'tool', toolName: 'Write' }],
      additionalPermissionProposal: proposal,
    });
    assert.equal(denied.kind, 'block');
  });

  test('requires an absolute cwd for the approval context', () => {
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const verdict = createFixture().engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: 'workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args }),
    });

    assert.equal(verdict.kind, 'block');
    if (verdict.kind === 'block') assert.match(verdict.reason, /canonical cwd/);
  });
});

describe('PermissionEngine one-shot additional permission grants', () => {
  test('issues an immutable intent-bound grant and consumes it exactly once', async () => {
    const { engine } = createFixture();
    const args = { command: 'curl https://example.test' };
    const proposal = createNetworkProposal({ toolName: 'Bash', args });
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args,
      mode: 'ask',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;

    engine.recordResponse('turn-1', {
      requestId: verdict.event.requestId,
      decision: 'allow',
    });
    assert.deepEqual(await verdict.parked, {
      requestId: verdict.event.requestId,
      decision: 'allow',
    });

    const grant = engine.consumeAdditionalPermissionGrant({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      intentHash: proposal.intentHash,
    });
    assert.ok(grant);
    assert.equal(grant.permissionsHash, proposal.permissionsHash);
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(Object.isFrozen(grant.profile), true);
    assert.throws(
      () =>
        engine.consumeAdditionalPermissionGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          intentHash: proposal.intentHash,
        }),
      (error: unknown) =>
        error instanceof AdditionalPermissionError && error.reason === 'grant_already_consumed',
    );
  });

  test('a mismatched consumer cannot burn a valid grant', () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const proposal = createNetworkProposal({ toolName: 'Write', args });
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });

    assert.throws(
      () =>
        engine.consumeAdditionalPermissionGrant({
          sessionId: 'other-session',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Write',
          intentHash: proposal.intentHash,
        }),
      (error: unknown) =>
        error instanceof AdditionalPermissionError && error.reason === 'grant_intent_mismatch',
    );
    assert.ok(
      engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'Write',
        intentHash: proposal.intentHash,
      }),
    );
  });

  test('denial creates no grant and remember-for-turn cannot widen a one-shot request', async () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const proposal = createNetworkProposal({ toolName: 'Write', args });
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;

    assert.throws(
      () =>
        engine.recordResponse('turn-1', {
          requestId: verdict.event.requestId,
          decision: 'allow',
          rememberForTurn: true,
        }),
      /cannot use rememberForTurn/,
    );
    assert.equal(engine.pendingCount('turn-1'), 1);

    engine.recordResponse('turn-1', {
      requestId: verdict.event.requestId,
      decision: 'deny',
    });
    assert.equal((await verdict.parked).decision, 'deny');
    assert.equal(
      engine.consumeAdditionalPermissionGrant({
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'Write',
        intentHash: proposal.intentHash,
      }),
      undefined,
    );
  });

  test('remembered tool approval does not absorb a same-scope one-shot request', async () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const toolPermission = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'ask',
    });
    const additionalPermission = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-2',
      toolName: 'Write',
      args,
      mode: 'ask',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args }),
    });
    assert.equal(toolPermission.kind, 'prompt');
    assert.equal(additionalPermission.kind, 'prompt');
    if (toolPermission.kind !== 'prompt' || additionalPermission.kind !== 'prompt') return;

    engine.recordResponse('turn-1', {
      requestId: toolPermission.event.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });
    await toolPermission.parked;

    assert.equal(engine.pendingCount('turn-1'), 1);
    engine.recordResponse('turn-1', {
      requestId: additionalPermission.event.requestId,
      decision: 'deny',
    });
    assert.equal((await additionalPermission.parked).decision, 'deny');
  });

  test('expired grants fail closed', () => {
    const { engine, setNow } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const proposal = createNetworkProposal({ toolName: 'Write', args });
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: proposal,
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'allow' });
    setNow(100 + DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS);

    assert.throws(
      () =>
        engine.consumeAdditionalPermissionGrant({
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-1',
          toolName: 'Write',
          intentHash: proposal.intentHash,
        }),
      (error: unknown) =>
        error instanceof AdditionalPermissionError && error.reason === 'grant_expired',
    );
  });

  test('timeout and turn termination reject parked requests with typed reasons', async () => {
    const first = createFixture();
    const firstArgs = { path: '/workspace/first.txt', content: 'ok' };
    const timed = first.engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: firstArgs,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args: firstArgs }),
    });
    assert.equal(timed.kind, 'prompt');
    if (timed.kind !== 'prompt') return;
    const timedRejection = assert.rejects(
      timed.parked,
      (error: unknown) =>
        error instanceof AdditionalPermissionError &&
        error.reason === 'additional_permission_timeout',
    );
    first.engine.expireRequest('turn-1', timed.event.requestId, 'permission timed out');
    await timedRejection;
    assert.equal(
      first.engine.recordResponse('turn-1', {
        requestId: timed.event.requestId,
        decision: 'allow',
      }),
      null,
    );

    const second = createFixture();
    const secondArgs = { path: '/workspace/second.txt', content: 'ok' };
    const aborted = second.engine.evaluate({
      sessionId: 'session-2',
      turnId: 'turn-2',
      toolUseId: 'tool-2',
      toolName: 'Write',
      args: secondArgs,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args: secondArgs }),
    });
    assert.equal(aborted.kind, 'prompt');
    if (aborted.kind !== 'prompt') return;
    const abortedRejection = assert.rejects(
      aborted.parked,
      (error: unknown) =>
        error instanceof AdditionalPermissionError &&
        error.reason === 'additional_permission_aborted',
    );
    second.engine.endTurn('turn-2', 'aborted');
    await abortedRejection;
  });

  test('rejects malformed responses without settling the request', async () => {
    const { engine } = createFixture();
    const args = { path: '/workspace/output.txt', content: 'ok' };
    const verdict = engine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args,
      mode: 'execute',
      cwd: '/workspace',
      additionalPermissionProposal: createNetworkProposal({ toolName: 'Write', args }),
    });
    assert.equal(verdict.kind, 'prompt');
    if (verdict.kind !== 'prompt') return;

    assert.throws(
      () =>
        engine.recordResponse('turn-1', {
          requestId: verdict.event.requestId,
          decision: 'approve',
        } as unknown as PermissionResponse),
      /Invalid permission response/,
    );
    assert.equal(engine.pendingCount('turn-1'), 1);
    engine.recordResponse('turn-1', { requestId: verdict.event.requestId, decision: 'deny' });
    await verdict.parked;
  });
});
