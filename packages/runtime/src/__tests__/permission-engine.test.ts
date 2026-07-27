/**
 * Tests for PermissionEngine — wraps the pure preToolUse() with state,
 * requestId generation, and parked-Promise resumption.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import { PermissionEngine, type PermissionEngineDeps } from '../permission-engine.js';
import type { HostedInteractionBridge, HostedPermissionAnswer } from '@maka/core/backend-types';
import type { PermissionResponse, ToolExecutionFacts } from '@maka/core/permission';

const LOCAL_EXECUTION_FACTS: ToolExecutionFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

function makeEngine(): { engine: PermissionEngine; deps: TestDeps } {
  const deps = new TestDeps();
  return { engine: new PermissionEngine(deps), deps };
}

class TestDeps implements PermissionEngineDeps {
  private idSeq = 0;
  private clock = 1_000_000;
  newId = (): string => `id-${++this.idSeq}`;
  now = (): number => this.clock++;
}

describe('PermissionEngine.evaluate — allow path', () => {
  test('allow for read in any mode', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Read',
      args: {},
      mode: 'explore',
    });
    expect(r.kind).toBe('allow');
  });

  test('allow when the same tool scope was remembered for this turn', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    // First Write in ask mode → prompt
    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    expect(r1.kind).toBe('prompt');

    if (r1.kind !== 'prompt') return;
    engine.recordResponse('t1', {
      requestId: r1.event.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });
    await r1.parked;

    // Same Write target → allow (remembered)
    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    expect(r2.kind).toBe('allow');

    // Different Write target → prompt; remembering one file path does
    // not authorize a different file in the same broad category.
    const r3 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu3',
      toolName: 'Write',
      args: { path: '/y' },
      mode: 'ask',
    });
    expect(r3.kind).toBe('prompt');
  });
});

describe('PermissionEngine.evaluate — invocation-local rules', () => {
  test('explicit deny wins over allow and applies to permission-free tools in bypass mode', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const result = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Read',
      args: { path: '/repo/file.ts' },
      mode: 'bypass',
      permissionRequired: false,
      permissionRules: [
        { effect: 'allow', kind: 'category', category: 'read' },
        { effect: 'deny', kind: 'category', category: 'read' },
      ],
    });

    assert.equal(result.kind, 'block');
    if (result.kind !== 'block') return;
    assert.equal(result.category, 'read');
    assert.equal(result.decisionEvent?.decision, 'deny');
    assert.equal(result.decisionEvent?.toolUseId, 'tu1');
  });

  test('explicit category allow overrides the explore policy block', () => {
    const { engine } = makeEngine();
    const result = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/repo/file.ts' },
      mode: 'explore',
      permissionRules: [{ effect: 'allow', kind: 'category', category: 'file_write' }],
    });

    assert.equal(result.kind, 'allow');
  });

  test('Bash rules use exact command equality without whitespace rewriting', () => {
    const rules = [{ effect: 'allow', kind: 'bash_exact', command: 'npm  test' }] as const;
    const { engine } = makeEngine();
    const exact = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Bash',
      args: { command: 'npm  test' },
      mode: 'explore',
      permissionRules: rules,
    });
    const normalized = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Bash',
      args: { command: 'npm test' },
      mode: 'explore',
      permissionRules: rules,
    });

    assert.equal(exact.kind, 'allow');
    assert.equal(normalized.kind, 'block');
  });

  test('exact tool rules authorize WriteStdin without authorizing Bash', () => {
    const rules = [{ effect: 'allow', kind: 'tool', toolName: 'WriteStdin' }] as const;
    const { engine } = makeEngine();
    const writeStdin = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'WriteStdin',
      args: { ref: 'maka://runtime/background-tasks/pty-1', input: '\\r' },
      mode: 'explore',
      permissionRules: rules,
    });
    const bash = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Bash',
      args: { command: 'echo no' },
      mode: 'explore',
      permissionRules: rules,
    });

    assert.equal(writeStdin.kind, 'allow');
    assert.equal(bash.kind, 'block');
  });

  test('an unrelated rule preserves the permission-free tool fast path', () => {
    const { engine } = makeEngine();
    const result = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Read',
      args: { path: '/repo/file.ts' },
      mode: 'explore',
      permissionRequired: false,
      permissionRules: [{ effect: 'deny', kind: 'category', category: 'file_write' }],
    });

    assert.equal(result.kind, 'allow');
  });
});

describe('PermissionEngine.evaluate — block path', () => {
  test('block in explore mode', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'explore',
    });
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.reason).toContain('blocked');
    }
  });

  test('uses categoryHint for custom read-only subagent tools', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'ExploreAgent',
      args: { objective: 'map permission code' },
      categoryHint: 'subagent',
      mode: 'explore',
    });
    expect(r.kind).toBe('allow');
    if (r.kind === 'allow') {
      expect(r.category).toBe('subagent');
    }
  });
});

describe('PermissionEngine.evaluate — prompt path', () => {
  test('allows execute shell_unsafe when the runtime reports an enforceable sandbox', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Bash',
      args: { command: 'npm install lodash' },
      mode: 'execute',
      sandbox: { platformSandboxAvailable: true },
    });

    expect(r.kind).toBe('allow');
  });

  test('execution facts are accepted but do not (yet) downgrade host-local shell to allow', () => {
    // executionFacts is plumbed for forward-compat: a future sandbox-aware
    // policy may auto-allow unsafe shell inside an isolated worktree. On the
    // HOST (isolation: 'none') execute mode is fail-closed, so an unrecognized
    // command prompts regardless of the facts being present.
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Bash',
      args: { command: 'npm install lodash' },
      mode: 'execute',
      executionFacts: LOCAL_EXECUTION_FACTS,
    });
    expect(r.kind).toBe('prompt');
    if (r.kind === 'prompt') {
      expect(r.event.category).toBe('shell_unsafe');
    }
  });

  test('emits PermissionRequestEvent with stable requestId', () => {
    const { engine, deps: _deps } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    expect(r.kind).toBe('prompt');
    if (r.kind !== 'prompt') return;
    expect(r.event.type).toBe('permission_request');
    expect(r.event.turnId).toBe('t1');
    expect(r.event.toolUseId).toBe('tu1');
    expect(r.event.requestId).toMatch(/^id-/);
    expect(r.event.rememberForTurnAllowed).toBe(true);
  });

  test('preserves exact WriteStdin permission args and disables turn memory', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const args = {
      ref: 'maka://runtime/background-tasks/pty-1',
      input: 'private input\r',
      size: { cols: 100, rows: 30 },
    };
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu-stdin',
      toolName: 'WriteStdin',
      args,
      mode: 'ask',
    });

    assert.equal(r.kind, 'prompt');
    if (r.kind !== 'prompt') return;
    assert.deepEqual(r.event.args, args);
    assert.equal(r.event.rememberForTurnAllowed, false);
  });

  test('parked Promise resolves on recordResponse', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');

    const response: PermissionResponse = {
      requestId: r.event.requestId,
      decision: 'allow',
    };
    const recorded = engine.recordResponse('t1', response);
    expect(recorded).not.toBeNull();
    expect(recorded?.toolUseId).toBe('tu1');

    const resolved = await r.parked;
    expect(resolved.decision).toBe('allow');
  });

  test('deny → parked resolves with decision=deny', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Bash',
      args: { command: 'rm foo' },
      mode: 'ask',
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');

    engine.recordResponse('t1', { requestId: r.event.requestId, decision: 'deny' });
    const out = await r.parked;
    expect(out.decision).toBe('deny');
  });
});

describe('PermissionEngine — turn lifecycle', () => {
  test('endTurn rejects parked Promises', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');

    const parkedPromise = r.parked.then(
      () => 'resolved',
      (e: Error) => `rejected:${e.message}`,
    );

    engine.endTurn('t1', 'aborted');
    const settled = await parkedPromise;
    expect(settled).toContain('rejected');
    expect(settled).toContain('aborted');
  });

  test('endTurn clears state', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    expect(engine.pendingCount('t1')).toBe(0);
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    const parkedPromise =
      r.kind === 'prompt' ? r.parked.catch((e: Error) => e) : Promise.resolve(null);
    expect(engine.pendingCount('t1')).toBe(1);
    engine.endTurn('t1');
    await parkedPromise;
    expect(engine.pendingCount('t1')).toBe(0);
  });

  test('expireRequest rejects one parked request and ignores late responses', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');
    const parkedPromise = r.parked.then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    );

    const expired = engine.expireRequest('t1', r.event.requestId, 'permission timed out');

    assert.deepEqual(expired, { category: 'file_write', toolUseId: 'tu1' });
    expect(engine.pendingCount('t1')).toBe(0);
    expect(await parkedPromise).toBe('rejected:permission timed out');
    expect(
      engine.recordResponse('t1', { requestId: r.event.requestId, decision: 'allow' }),
    ).toBeNull();
  });

  test('allow + rememberForTurn absorbs other parked requests sharing the scope', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    // Two writes to the same path parked in parallel — neither answered yet, so
    // the second still prompts (the scope is not yet remembered).
    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    if (r1.kind !== 'prompt' || r2.kind !== 'prompt') throw new Error('expected prompts');
    expect(engine.pendingCount('t1')).toBe(2);

    // Answer the first with allow + remember-for-turn.
    engine.recordResponse('t1', {
      requestId: r1.event.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });

    // The second resolves on its own (no second prompt), as allow, under its own id.
    const resolved2 = await r2.parked;
    expect(resolved2.decision).toBe('allow');
    expect(resolved2.requestId).toBe(r2.event.requestId);
    expect(engine.pendingCount('t1')).toBe(0);
  });

  test('allow WITHOUT remember leaves other parked requests untouched', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    if (r1.kind !== 'prompt' || r2.kind !== 'prompt') throw new Error('expected prompts');
    engine.recordResponse('t1', { requestId: r1.event.requestId, decision: 'allow' }); // no rememberForTurn
    expect(engine.pendingCount('t1')).toBe(1); // r2 still parked
  });

  test('a request that forbids turn memory rejects a forged remember response without losing the request', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const first = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'maka_computer',
      args: { action: 'type', text: 'secret' },
      categoryHint: 'computer_use',
      mode: 'execute',
    });
    if (first.kind !== 'prompt') throw new Error('expected prompt');
    assert.equal(first.event.rememberForTurnAllowed, false);

    assert.throws(
      () =>
        engine.recordResponse('t1', {
          requestId: first.event.requestId,
          decision: 'allow',
          rememberForTurn: true,
        }),
      /cannot be remembered/,
    );
    assert.equal(engine.pendingCount('t1'), 1);

    engine.recordResponse('t1', {
      requestId: first.event.requestId,
      decision: 'allow',
    });
    assert.equal((await first.parked).decision, 'allow');

    const second = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'maka_computer',
      args: { action: 'type', text: 'other secret' },
      categoryHint: 'computer_use',
      mode: 'execute',
    });
    assert.equal(second.kind, 'prompt');
  });

  test('permission evaluation snapshots args before a caller can mutate them', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const args = {
      action: 'left_click',
      app: 'Example',
      observation_id: 'frame-1',
      coordinate: [10, 20],
    };
    const result = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'maka_computer',
      args,
      categoryHint: 'computer_use',
      mode: 'execute',
    });
    if (result.kind !== 'prompt') throw new Error('expected prompt');
    args.app = 'Mutated';
    args.observation_id = 'frame-999';
    assert.deepEqual(result.event.args, {
      action: 'left_click',
      approvalClass: 'pointer_mutation',
      rememberForTurnAllowed: true,
      app: 'Example',
      observationId: 'frame-1',
    });
  });

  test('permission evaluation rejects accessors without invoking them', () => {
    const { engine } = makeEngine();
    let reads = 0;
    const args = {
      action: 'observe',
      get app() {
        reads += 1;
        return 'Example';
      },
    };
    assert.throws(() =>
      engine.evaluate({
        sessionId: 's1',
        turnId: 't1',
        toolUseId: 'tu1',
        toolName: 'maka_computer',
        args,
        categoryHint: 'computer_use',
        mode: 'execute',
      }),
    );
    assert.equal(reads, 0);
  });

  test('remember does not absorb a parked request in a different scope', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: '/x' },
      mode: 'ask',
    });
    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: { path: '/y' },
      mode: 'ask',
    });
    if (r1.kind !== 'prompt' || r2.kind !== 'prompt') throw new Error('expected prompts');
    engine.recordResponse('t1', {
      requestId: r1.event.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });
    expect(engine.pendingCount('t1')).toBe(1); // different path → different scope → still parked
  });

  test('beginTurn is idempotent', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    engine.beginTurn('t1');
    // No throw, state intact:
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Read',
      args: {},
      mode: 'explore',
    });
    expect(r.kind).toBe('allow');
  });
});

describe('PermissionEngine — recordResponse edge cases', () => {
  test('preserves auto-review rationale through hosted commit and settlement', async () => {
    const { engine } = makeEngine();
    let committed: HostedPermissionAnswer | undefined;
    const hostedInteraction: HostedInteractionBridge = {
      sessionId: 's1',
      turnId: 't1',
      runId: 'run-1',
      admitPermissionRequest: async () => ({ state: 'pending' }),
      commitPermissionAnswer: async ({ answer }) => {
        committed = answer;
      },
      commitPermissionTimeout: async () => ({ kind: 'closure', reason: 'timed_out' }),
      admitUserQuestionRequest: async () => {},
    };
    engine.beginTurn('t1');
    const result = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      runId: 'run-1',
      hostedInteraction,
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (result.kind !== 'prompt') throw new Error('expected prompt');
    assert.ok(result.settlement);

    engine.recordResponse('t1', {
      requestId: result.event.requestId,
      decision: 'allow',
      reviewer: 'auto_review',
      rationale: 'Exact write target is allowed.',
      riskLevel: 'low',
    });
    await Promise.resolve();
    assert.deepEqual(committed, {
      decision: 'allow',
      reviewer: 'auto_review',
      rationale: 'Exact write target is allowed.',
      riskLevel: 'low',
    });

    await result.settlement.applyAnswer({ ...committed!, rememberForTurn: false });
    assert.deepEqual(await result.parked, {
      requestId: result.event.requestId,
      decision: 'allow',
      rememberForTurn: false,
      reviewer: 'auto_review',
      rationale: 'Exact write target is allowed.',
      riskLevel: 'low',
    });
  });

  test('malformed response decisions fail closed before resolving parked tools', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const r = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (r.kind !== 'prompt') throw new Error('expected prompt');

    assert.throws(
      () =>
        engine.recordResponse('t1', {
          requestId: r.event.requestId,
          decision: 'approve',
        } as unknown as PermissionResponse),
      /Invalid permission response/,
    );
    assert.throws(
      () =>
        engine.recordResponse('t1', {
          requestId: r.event.requestId,
          decision: 'allow',
          rememberForTurn: 'yes',
        } as unknown as PermissionResponse),
      /Invalid permission response/,
    );
    expect(engine.pendingCount('t1')).toBe(1);

    engine.recordResponse('t1', { requestId: r.event.requestId, decision: 'deny' });
    const resolved = await r.parked;
    expect(resolved.decision).toBe('deny');
  });

  test('completes a WriteStdin denial without granting turn memory', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const args = {
      ref: 'maka://runtime/background-tasks/pty-1',
      input: 'n\r',
    };
    const first = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'WriteStdin',
      args,
      mode: 'ask',
    });
    if (first.kind !== 'prompt') throw new Error('expected prompt');

    engine.recordResponse('t1', {
      requestId: first.event.requestId,
      decision: 'deny',
      rememberForTurn: true,
    });
    assert.equal((await first.parked).decision, 'deny');
    assert.equal(engine.pendingCount('t1'), 0);

    const repeated = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'WriteStdin',
      args,
      mode: 'ask',
    });
    assert.equal(repeated.kind, 'prompt');
  });

  test('unknown requestId → null, no throw', () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');
    const result = engine.recordResponse('t1', {
      requestId: 'nonexistent',
      decision: 'allow',
    });
    expect(result).toBeNull();
  });

  test('unknown turnId → null', () => {
    const { engine } = makeEngine();
    const result = engine.recordResponse('nonexistent-turn', {
      requestId: 'x',
      decision: 'allow',
    });
    expect(result).toBeNull();
  });

  test('rememberForTurn=true persists only the same tool scope', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');

    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: { path: 'notes.md' },
      mode: 'ask',
    });
    if (r1.kind !== 'prompt') throw new Error('expected prompt');
    engine.recordResponse('t1', {
      requestId: r1.event.requestId,
      decision: 'allow',
      rememberForTurn: true,
    });
    await r1.parked;

    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: { path: 'notes.md' },
      mode: 'ask',
    });
    expect(r2.kind).toBe('allow');

    const r3 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu3',
      toolName: 'Edit',
      args: { path: 'notes.md' },
      mode: 'ask',
    });
    expect(r3.kind).toBe('prompt');
  });

  test('rememberForTurn=false does NOT add to set', async () => {
    const { engine } = makeEngine();
    engine.beginTurn('t1');

    const r1 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu1',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    if (r1.kind !== 'prompt') throw new Error('expected prompt');
    engine.recordResponse('t1', {
      requestId: r1.event.requestId,
      decision: 'allow',
      // rememberForTurn omitted
    });
    await r1.parked;

    const r2 = engine.evaluate({
      sessionId: 's1',
      turnId: 't1',
      toolUseId: 'tu2',
      toolName: 'Write',
      args: {},
      mode: 'ask',
    });
    expect(r2.kind).toBe('prompt');
  });
});
