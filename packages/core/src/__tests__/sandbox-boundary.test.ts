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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applySandboxBoundaryExpansion,
  assessSandboxBoundaryExpansion,
  createGenesisExecutionBoundary,
  decodeExecutionBoundary,
  executionBoundaryContains,
  executionBoundaryDisplayMode,
  projectSandboxBoundaryNegotiation as projectSandboxBoundaryNegotiationImpl,
  type SandboxBoundaryRequest,
  validateSandboxBoundaryExpansion,
} from '../sandbox-boundary.js';
import type { RuntimeEvent } from '../runtime-event.js';
import {
  canReadPath,
  canWritePath,
  createDangerFullAccessPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfileManaged,
} from '../permission-profile.js';

const projectSandboxBoundaryNegotiation = (
  events: readonly RuntimeEvent[],
  durableRequests: readonly SandboxBoundaryRequest[] = [],
) => projectSandboxBoundaryNegotiationImpl(events, durableRequests);

describe('executionBoundaryDisplayMode', () => {
  test('keeps the read-only/writable distinction the boundary carries (#1611)', () => {
    assert.strictEqual(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createReadOnlyPermissionProfile(),
        revision: 0,
      }),
      'explore',
    );
    assert.strictEqual(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 0,
      }),
      'ask',
    );
    assert.strictEqual(executionBoundaryDisplayMode({ kind: 'bypass', revision: 1 }), 'bypass');
    assert.strictEqual(
      executionBoundaryDisplayMode({ kind: 'managed', access: 'read_only', revision: 2 }),
      'explore',
    );
    assert.strictEqual(
      executionBoundaryDisplayMode({ kind: 'managed', access: 'writable', revision: 2 }),
      'ask',
    );
  });

  test('an approved expansion that grants a write stops reading as read-only', () => {
    const widened = applySandboxBoundaryExpansion(createReadOnlyPermissionProfile(), {
      filesystem: { entries: [{ path: '/outside/dist', access: 'write', scope: 'subtree' }] },
    });

    assert.strictEqual(
      executionBoundaryDisplayMode({ kind: 'managed', profile: widened, revision: 1 }),
      'ask',
    );
  });

  test('under-states danger-full-access as Auto rather than naming a mode for it', () => {
    // A deliberate collapse, NOT a description of this profile: the picker
    // offers two modes and no third one is being invented for a profile the
    // product does not hand out. Auto's copy is written to stay true here —
    // it never claims a specific boundary — so this under-states rather than
    // misstates. If Auto's hint ever names a boundary again, this mapping
    // becomes a lie and has to change with it.
    assert.strictEqual(
      executionBoundaryDisplayMode({
        kind: 'managed',
        profile: createDangerFullAccessPermissionProfile(),
        revision: 0,
      }),
      'ask',
    );
  });

  test('an externally isolated boundary has no locally controllable mode', () => {
    assert.strictEqual(executionBoundaryDisplayMode({ kind: 'external', revision: 0 }), undefined);
  });
});

describe('SandboxBoundaryExpansion', () => {
  test('accepts and canonicalizes only additive filesystem and network authority', () => {
    const result = validateSandboxBoundaryExpansion({
      filesystem: {
        entries: [
          { path: '/outside/tree/file.txt', access: 'read', scope: 'exact' },
          { path: '/outside/tree', access: 'read', scope: 'subtree' },
        ],
      },
      network: { enabled: true },
    });

    assert.deepStrictEqual(result, {
      ok: true,
      expansion: {
        filesystem: {
          entries: [{ path: '/outside/tree', access: 'read', scope: 'subtree' }],
        },
        network: { enabled: true },
      },
    });
  });

  test('accepts normalized Windows drive paths and compares them case-insensitively', () => {
    const result = validateSandboxBoundaryExpansion({
      filesystem: {
        entries: [
          { path: 'D:\\Outside\\Tree\\file.txt', access: 'read', scope: 'exact' },
          { path: 'd:\\outside\\tree', access: 'read', scope: 'subtree' },
        ],
      },
    });

    assert.deepStrictEqual(result, {
      ok: true,
      expansion: {
        filesystem: {
          entries: [{ path: 'd:\\outside\\tree', access: 'read', scope: 'subtree' }],
        },
      },
    });

    const widened = applySandboxBoundaryExpansion(createReadOnlyPermissionProfile(), {
      filesystem: {
        entries: [{ path: 'D:\\Outside\\Tree', access: 'read', scope: 'subtree' }],
      },
    });
    assert.strictEqual(canReadPath(widened, 'd:\\outside\\tree\\file.txt'), true);
    assert.strictEqual(canReadPath(widened, 'D:\\Outside\\Sibling\\file.txt'), false);

    assert.strictEqual(
      validateSandboxBoundaryExpansion({
        filesystem: { entries: [{ path: 'C:\\', access: 'read', scope: 'subtree' }] },
      }).ok,
      true,
    );
  });

  test('rejects non-normalized Windows boundary paths', () => {
    for (const path of [
      'D:\\outside\\..\\secret.txt',
      'D:/outside/secret.txt',
      '\\\\server\\share\\secret.txt',
      'D:\\outside\\',
    ]) {
      assert.strictEqual(
        validateSandboxBoundaryExpansion({
          filesystem: { entries: [{ path, access: 'read', scope: 'exact' }] },
        }).ok,
        false,
      );
    }
  });

  test('rejects empty, relative, deny, policy-shaped, and legacy expansions', () => {
    for (const expansion of [
      {},
      { filesystem: { entries: [] } },
      { filesystem: { entries: [{ path: '../outside', access: 'read', scope: 'exact' }] } },
      { filesystem: { entries: [{ path: '/outside', access: 'deny', scope: 'exact' }] } },
      { filesystem: { entries: [{ path: '/outside', access: 'read', scope: 'special' }] } },
      {
        filesystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact', kind: 'path' }],
        },
      },
      { network: { enabled: false } },
      { profile: { type: 'managed' } },
      { fileSystem: { entries: [{ path: '/legacy', access: 'read', scope: 'exact' }] } },
    ]) {
      assert.strictEqual(validateSandboxBoundaryExpansion(expansion).ok, false);
    }
  });

  test('applies additive authority without weakening an explicit deny', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' }],
      },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [
          { path: '/outside/open.txt', access: 'write', scope: 'exact' },
          { path: '/outside/locked/file.txt', access: 'write', scope: 'exact' },
        ],
      },
      network: { enabled: true },
    });

    assert.strictEqual(canWritePath(result, '/outside/open.txt'), true);
    assert.strictEqual(canReadPath(result, '/outside/locked/file.txt'), false);
    assert.strictEqual(canWritePath(result, '/outside/locked/file.txt'), false);
    assert.strictEqual(result.network.kind, 'enabled');
  });

  test('enables network when filesystem access is already unrestricted', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: { kind: 'unrestricted', entries: [] },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      network: { enabled: true },
    });

    assert.strictEqual(result.network.kind, 'enabled');
  });

  test('compacts cumulative explicit grants without changing special paths or denies', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'special', access: 'write', special: ':workspace_roots' },
          { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
          { kind: 'path', access: 'read', path: '/outside/tree/file.txt', match: 'exact' },
        ],
      },
      network: { kind: 'restricted' },
    };

    const result = applySandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [{ path: '/outside/tree', access: 'read', scope: 'subtree' }],
      },
    });

    assert.deepStrictEqual(result.fileSystem.entries, [
      { kind: 'special', access: 'write', special: ':workspace_roots' },
      { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
      { kind: 'path', access: 'read', path: '/outside/tree', match: 'subtree' },
    ]);
  });

  test('distinguishes a new expansion, an approved no-op, and an explicit-deny conflict', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [
          { kind: 'path', access: 'read', path: '/outside/already.txt', match: 'exact' },
          { kind: 'path', access: 'deny', path: '/outside/locked', match: 'subtree' },
        ],
      },
      network: { kind: 'restricted' },
    };

    assert.strictEqual(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/outside/already.txt', access: 'read', scope: 'exact' }],
        },
      }).outcome,
      'noop',
    );
    assert.strictEqual(
      assessSandboxBoundaryExpansion(base, {
        filesystem: { entries: [{ path: '/outside/new.txt', access: 'read', scope: 'exact' }] },
      }).outcome,
      'apply',
    );
    assert.deepStrictEqual(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/outside', access: 'write', scope: 'subtree' }],
        },
      }),
      { outcome: 'conflict', reason: 'explicit_deny' },
    );
  });

  test('does not treat a child of an exact path grant as already approved', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'read', path: '/outside', match: 'exact' }],
      },
      network: { kind: 'restricted' },
    };

    const assessment = assessSandboxBoundaryExpansion(base, {
      filesystem: {
        entries: [{ path: '/outside/child', access: 'read', scope: 'exact' }],
      },
    });

    assert.strictEqual(assessment.outcome, 'apply');
  });

  test('keeps explicit denies authoritative inside an otherwise unrestricted profile', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'unrestricted',
        entries: [{ kind: 'path', access: 'deny', path: '/locked', match: 'subtree' }],
      },
      network: { kind: 'enabled' },
    };

    assert.deepStrictEqual(
      assessSandboxBoundaryExpansion(base, {
        filesystem: {
          entries: [{ path: '/locked/file.txt', access: 'read', scope: 'exact' }],
        },
      }),
      { outcome: 'conflict', reason: 'explicit_deny' },
    );
  });

  test('keeps protected metadata deny-write authoritative over exact write expansions', () => {
    const base: PermissionProfileManaged = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/workspace', match: 'subtree' }],
        protectedMetadata: {
          access: 'deny_write',
          names: ['.git'],
        },
      },
      network: { kind: 'restricted' },
    };

    assert.deepStrictEqual(
      assessSandboxBoundaryExpansion(
        base,
        {
          filesystem: {
            entries: [
              {
                path: '/workspace/.git/config',
                access: 'write',
                scope: 'exact',
              },
            ],
          },
        },
        { workspaceRoots: ['/workspace'] },
      ),
      { outcome: 'conflict', reason: 'explicit_deny' },
    );
  });

  test('uses the same default slash-tmp root as permission enforcement', () => {
    const assessment = assessSandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
      filesystem: {
        entries: [{ path: '/tmp/output.txt', access: 'write', scope: 'exact' }],
      },
    });

    assert.strictEqual(assessment.outcome, 'noop');
  });
});

describe('projectSandboxBoundaryNegotiation', () => {
  const base = (id: string, partial: Partial<RuntimeEvent>): RuntimeEvent => ({
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...partial,
  });

  const request = (id: string, requestId: string, toolUseId: string): RuntimeEvent =>
    base(id, {
      refs: { toolCallId: toolUseId },
      actions: {
        stateDelta: {
          sandboxBoundaryRequest: {
            requestId,
            toolUseId,
            justification: 'Need the smallest boundary expansion.',
            expansion: { network: { enabled: true } },
          },
        },
      },
    });

  const decision = (
    id: string,
    requestId: string,
    toolUseId: string,
    status: 'approved' | 'denied' | 'conflict',
  ): RuntimeEvent =>
    base(id, {
      author: 'user',
      refs: { toolCallId: toolUseId },
      actions: {
        stateDelta: {
          sandboxBoundaryDecision: {
            requestId,
            decision: status === 'denied' ? 'deny' : 'allow',
            status,
            revision: status === 'approved' ? 1 : 0,
          },
        },
      },
    });

  const durableRequest = (
    requestId: string,
    status: SandboxBoundaryRequest['status'],
  ): SandboxBoundaryRequest => ({
    sessionId: 'session-1',
    requestId,
    status,
    baseRevision: 0,
    expansion: { network: { enabled: true } },
    justification: 'Need network access.',
    createdAt: 1,
    settledAt: 2,
    ...(status === 'approved' ? { appliedRevision: 1 } : {}),
    turnId: 'turn-1',
    runId: 'run-1',
  });

  const failurePair = (
    id: string,
    toolName: string,
    toolCallId: string,
    reason: 'invalid_boundary_declaration' | 'sandbox_boundary_required',
    hidden = false,
  ): RuntimeEvent[] => [
    base(`${id}-call`, {
      role: 'model',
      author: 'agent',
      ...(hidden ? { modelVisibility: 'hidden' as const } : {}),
      refs: { toolCallId, stepId: `${id}-step` },
      content: {
        kind: 'function_call',
        id: toolCallId,
        name: toolName,
        args: toolName === 'Bash' ? { boundary_intent: 'expand' } : {},
      },
    }),
    base(`${id}-response`, {
      role: 'tool',
      author: 'tool',
      ...(hidden ? { modelVisibility: 'hidden' as const } : {}),
      refs: { toolCallId, stepId: `${id}-step` },
      content: {
        kind: 'function_response',
        id: toolCallId,
        name: toolName,
        isError: true,
        result: {
          kind: 'text',
          text: 'Sandbox boundary correction failed.',
          sandboxFailure: { reason },
        },
      },
    }),
  ];

  test('restores denial and both correction budgets, including hidden Code Mode calls', () => {
    const events = [
      request('request-1', 'boundary-1', 'tool-1'),
      decision('decision-1', 'boundary-1', 'tool-1', 'denied'),
      ...failurePair(
        'invalid-1',
        'request_sandbox_boundary',
        'tool-2',
        'invalid_boundary_declaration',
      ),
      ...failurePair('unresolved-1', 'Bash', 'tool-3', 'sandbox_boundary_required', true),
    ];

    assert.deepEqual(projectSandboxBoundaryNegotiation(events), {
      kind: 'valid',
      state: {
        denied: true,
        invalidRounds: 0,
        unresolvedRounds: 0,
        finalizationRequested: true,
      },
    });
  });

  test('counts nested Code Mode boundary failures once per parent tool step', () => {
    const events = ['one', 'two', 'three'].flatMap((id) => {
      const toolCallId = `nested-${id}`;
      const refs = { toolCallId, parentToolCallId: 'code-cell-1' };
      return [
        base(`${id}-call`, {
          role: 'model',
          author: 'agent',
          modelVisibility: 'hidden',
          refs,
          content: {
            kind: 'function_call',
            id: toolCallId,
            name: 'Bash',
            args: { boundary_intent: 'expand' },
          },
        }),
        base(`${id}-response`, {
          role: 'tool',
          author: 'tool',
          modelVisibility: 'hidden',
          refs,
          content: {
            kind: 'function_response',
            id: toolCallId,
            name: 'Bash',
            isError: true,
            result: {
              kind: 'text',
              text: 'Sandbox boundary correction failed.',
              sandboxFailure: { reason: 'invalid_boundary_declaration' },
            },
          },
        }),
      ];
    });

    assert.deepEqual(projectSandboxBoundaryNegotiation(events), {
      kind: 'valid',
      state: {
        denied: false,
        invalidRounds: 1,
        unresolvedRounds: 0,
        finalizationRequested: false,
      },
    });
  });

  test('fails closed when approval reopens a denied or finalized negotiation', () => {
    const deniedThenApproved = [
      request('request-1', 'boundary-1', 'tool-1'),
      decision('decision-1', 'boundary-1', 'tool-1', 'denied'),
      request('request-2', 'boundary-2', 'tool-2'),
      decision('decision-2', 'boundary-2', 'tool-2', 'approved'),
    ];
    assert.equal(projectSandboxBoundaryNegotiation(deniedThenApproved).kind, 'invalid');

    const finalizedThenApproved = [
      ...failurePair(
        'invalid-1',
        'request_sandbox_boundary',
        'tool-1',
        'invalid_boundary_declaration',
      ),
      ...failurePair(
        'invalid-2',
        'request_sandbox_boundary',
        'tool-2',
        'invalid_boundary_declaration',
      ),
      ...failurePair(
        'invalid-3',
        'request_sandbox_boundary',
        'tool-3',
        'invalid_boundary_declaration',
      ),
      request('request-1', 'boundary-1', 'tool-4'),
      decision('decision-1', 'boundary-1', 'tool-4', 'approved'),
    ];
    assert.equal(projectSandboxBoundaryNegotiation(finalizedThenApproved).kind, 'invalid');
  });

  test('approved requests reset prior correction state', () => {
    const events = [
      ...failurePair(
        'invalid-1',
        'request_sandbox_boundary',
        'tool-1',
        'invalid_boundary_declaration',
      ),
      request('request-1', 'boundary-1', 'tool-2'),
      decision('decision-1', 'boundary-1', 'tool-2', 'approved'),
    ];
    assert.deepEqual(projectSandboxBoundaryNegotiation(events), {
      kind: 'valid',
      state: {
        denied: false,
        invalidRounds: 0,
        unresolvedRounds: 0,
        finalizationRequested: false,
      },
    });
  });

  test('fails closed for malformed or legacy boundary facts', () => {
    const malformed = request('request-1', 'boundary-1', 'tool-1');
    malformed.actions!.stateDelta!.sandboxBoundaryRequest = {
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'missing expansion',
    };
    assert.equal(projectSandboxBoundaryNegotiation([malformed]).kind, 'invalid');

    const [call, response] = failurePair(
      'legacy-1',
      'request_sandbox_boundary',
      'tool-1',
      'invalid_boundary_declaration',
    );
    (response.content as Extract<RuntimeEvent['content'], { kind: 'function_response' }>).result = {
      kind: 'text',
      text: 'Tool arguments failed validation',
    };
    assert.deepEqual(projectSandboxBoundaryNegotiation([call, response]), {
      kind: 'valid',
      state: {
        denied: false,
        invalidRounds: 0,
        unresolvedRounds: 0,
        finalizationRequested: false,
      },
    });

    const blankJustification = request('request-2', 'boundary-2', 'tool-2');
    (
      blankJustification.actions!.stateDelta!.sandboxBoundaryRequest as { justification: string }
    ).justification = '   ';
    assert.equal(projectSandboxBoundaryNegotiation([blankJustification]).kind, 'invalid');

    const validRequest = request('request-3', 'boundary-3', 'tool-3');
    const malformedRevision = decision('decision-3', 'boundary-3', 'tool-3', 'denied');
    (
      malformedRevision.actions!.stateDelta!.sandboxBoundaryDecision as { revision: number }
    ).revision = 1.5;
    assert.equal(
      projectSandboxBoundaryNegotiation([validRequest, malformedRevision]).kind,
      'invalid',
    );
  });

  test('fails closed when boundary facts do not preserve call identity', () => {
    const mismatchedDecision = decision('decision-1', 'boundary-1', 'other-tool', 'denied');
    assert.equal(
      projectSandboxBoundaryNegotiation([
        request('request-1', 'boundary-1', 'tool-1'),
        mismatchedDecision,
      ]).kind,
      'invalid',
    );

    const [call, response] = failurePair(
      'invalid-1',
      'request_sandbox_boundary',
      'tool-1',
      'invalid_boundary_declaration',
    );
    (response.content as Extract<RuntimeEvent['content'], { kind: 'function_response' }>).name =
      'Bash';
    assert.equal(projectSandboxBoundaryNegotiation([call, response]).kind, 'invalid');

    const originalRequest = request('request-2', 'boundary-2', 'tool-2');
    const mismatchedIdentityDecision = decision('decision-2', 'boundary-2', 'tool-2', 'denied');
    mismatchedIdentityDecision.invocationId = 'other-invocation';
    assert.equal(
      projectSandboxBoundaryNegotiation([originalRequest, mismatchedIdentityDecision]).kind,
      'invalid',
    );
  });

  test('fails closed when a boundary failure marker is attached to a non-boundary tool', () => {
    const [call, response] = failurePair(
      'forged-1',
      'Read',
      'tool-1',
      'invalid_boundary_declaration',
    );
    assert.equal(projectSandboxBoundaryNegotiation([call, response]).kind, 'invalid');
  });

  test('counts internal invalid repair calls as boundary attempts', () => {
    const events = [
      base('repair-call', {
        role: 'model',
        author: 'agent',
        refs: { toolCallId: 'repair-tool' },
        content: {
          kind: 'function_call',
          id: 'repair-tool',
          name: 'invalid',
          args: {
            tool: 'request_sandbox_boundary',
            error: 'boundary was denied',
            sandboxBoundaryAttempt: true,
          },
        },
      }),
      base('repair-response', {
        role: 'tool',
        author: 'tool',
        refs: { toolCallId: 'repair-tool' },
        content: {
          kind: 'function_response',
          id: 'repair-tool',
          name: 'invalid',
          isError: true,
          result: {
            kind: 'text',
            text: 'Sandbox boundary correction failed.',
            sandboxFailure: { reason: 'invalid_boundary_declaration' },
          },
        },
      }),
    ];

    assert.deepEqual(projectSandboxBoundaryNegotiation(events), {
      kind: 'valid',
      state: {
        denied: false,
        invalidRounds: 1,
        unresolvedRounds: 0,
        finalizationRequested: false,
      },
    });
  });

  test('requests finalization after the bounded correction budget', () => {
    const events = [
      ...failurePair(
        'invalid-1',
        'request_sandbox_boundary',
        'tool-1',
        'invalid_boundary_declaration',
      ),
      ...failurePair(
        'invalid-2',
        'request_sandbox_boundary',
        'tool-2',
        'invalid_boundary_declaration',
      ),
      ...failurePair(
        'invalid-3',
        'request_sandbox_boundary',
        'tool-3',
        'invalid_boundary_declaration',
      ),
    ];
    const result = projectSandboxBoundaryNegotiation(events);
    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') assert.equal(result.state.finalizationRequested, true);
  });

  test('restores a durable denial when the RuntimeEvent ack was lost', () => {
    const durable = durableRequest('boundary-1', 'denied');
    assert.deepEqual(
      projectSandboxBoundaryNegotiation(
        [base('source-event', { turnId: 'turn-1', runId: 'run-1' })],
        [durable],
      ),
      {
        kind: 'valid',
        state: {
          denied: true,
          invalidRounds: 0,
          unresolvedRounds: 0,
          finalizationRequested: false,
        },
      },
    );
  });

  test('fails closed when durable settlement order is unavailable', () => {
    const approved = durableRequest('boundary-1', 'approved');
    assert.equal(
      projectSandboxBoundaryNegotiation(
        [
          request('request-1', 'boundary-1', 'tool-1'),
          ...failurePair(
            'invalid-1',
            'request_sandbox_boundary',
            'tool-2',
            'invalid_boundary_declaration',
          ),
        ],
        [approved],
      ).kind,
      'invalid',
    );

    const denied = durableRequest('boundary-1', 'denied');
    assert.equal(
      projectSandboxBoundaryNegotiation(
        [
          request('request-1', 'boundary-1', 'tool-1'),
          request('request-2', 'boundary-2', 'tool-2'),
          decision('decision-2', 'boundary-2', 'tool-2', 'approved'),
        ],
        [denied],
      ).kind,
      'invalid',
    );
  });

  test('does not treat a host-restart closure as a user denial', () => {
    const restartClosed = {
      ...durableRequest('boundary-1', 'denied'),
      outcomeReason: 'host_restarted',
    };
    assert.deepEqual(
      projectSandboxBoundaryNegotiation(
        [request('request-1', 'boundary-1', 'tool-1')],
        [restartClosed],
      ),
      {
        kind: 'valid',
        state: {
          denied: false,
          invalidRounds: 0,
          unresolvedRounds: 0,
          finalizationRequested: false,
        },
      },
    );

    assert.deepEqual(
      projectSandboxBoundaryNegotiation(
        [
          request('request-1', 'boundary-1', 'tool-1'),
          decision('decision-1', 'boundary-1', 'tool-1', 'approved'),
          request('request-2', 'boundary-2', 'tool-2'),
        ],
        [{ ...restartClosed, requestId: 'boundary-2' }],
      ),
      {
        kind: 'valid',
        state: {
          denied: false,
          invalidRounds: 0,
          unresolvedRounds: 0,
          finalizationRequested: false,
        },
      },
    );
  });
});

describe('ExecutionBoundary', () => {
  test('decodes only a complete full boundary snapshot', () => {
    const managed = createGenesisExecutionBoundary('ask');
    assert.deepStrictEqual(decodeExecutionBoundary(JSON.parse(JSON.stringify(managed))), managed);
    assert.deepStrictEqual(decodeExecutionBoundary({ kind: 'bypass', revision: 3 }), {
      kind: 'bypass',
      revision: 3,
    });

    for (const invalid of [
      { kind: 'managed', revision: 0 },
      { kind: 'bypass', revision: -1 },
      { kind: 'external', revision: 1, profile: {} },
      { kind: 'unknown', revision: 0 },
    ]) {
      assert.throws(() => decodeExecutionBoundary(invalid));
    }
  });

  test('round-trips managed protected-metadata policy', () => {
    const managed = createGenesisExecutionBoundary('ask');
    if (managed.kind !== 'managed') throw new Error('expected managed boundary');
    const boundary = {
      ...managed,
      profile: {
        ...managed.profile,
        fileSystem: {
          ...managed.profile.fileSystem,
          protectedMetadata: {
            access: 'deny_write' as const,
            names: ['.git', '.agents', '.codex'],
          },
        },
      },
    };

    assert.deepStrictEqual(decodeExecutionBoundary(JSON.parse(JSON.stringify(boundary))), boundary);
  });

  test('rejects a complete boundary snapshot above the shared capacity', () => {
    const managed = createGenesisExecutionBoundary('ask');
    if (managed.kind !== 'managed') throw new Error('expected managed boundary');
    const oversized = {
      ...managed,
      profile: {
        ...managed.profile,
        fileSystem: {
          ...managed.profile.fileSystem,
          entries: Array.from({ length: 300 }, (_, index) => ({
            kind: 'path' as const,
            access: 'read' as const,
            path: `/outside/${index}-${'x'.repeat(3_900)}`,
            match: 'exact' as const,
          })),
        },
      },
    };

    assert.throws(
      () => decodeExecutionBoundary(oversized),
      /Execution boundary exceeds the serialized size limit/,
    );
  });

  test('compares complete boundary authority with one canonical containment contract', () => {
    const auto = createGenesisExecutionBoundary('ask');
    const readOnly = createGenesisExecutionBoundary('explore');
    const bypass = createGenesisExecutionBoundary('bypass');
    const external = { kind: 'external', revision: 0 } as const;

    assert.strictEqual(executionBoundaryContains(auto, readOnly), true);
    assert.strictEqual(executionBoundaryContains(readOnly, auto), false);
    assert.strictEqual(executionBoundaryContains(bypass, external), true);
    assert.strictEqual(executionBoundaryContains(external, external), true);
    assert.strictEqual(executionBoundaryContains(external, auto), false);
    assert.strictEqual(executionBoundaryContains(auto, external), false);
  });
});
