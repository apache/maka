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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodeCollaborationInvitationCode,
  HOST_OPERATION_SPECS,
  type RequestFrame,
} from '../protocol/index.js';
import {
  openRuntimeHostAccessAuthority,
  queryCollaborationTurnRequests,
  type RuntimeHostAccessAuthority,
} from '../server/access-authority.js';
import {
  RuntimeHostAccessCommitOutcomeUnknownError,
  writeAccessCredentialFile,
} from '../server/access-credential-store.js';
import { authorizeRuntimeHostOperation } from '../server/connection-authority.js';
import { SessionTurnAccessRequestCoordinator } from '../server/session-turn-access-request-coordinator.js';

const LOCAL_OWNER = {
  principalId: 'local_owner',
  principalKind: 'local_owner',
} as const;

function sessionGuest(principalId: string) {
  return { principalId, principalKind: 'session_guest' as const };
}

async function unexpectedRegenerateTurn(): Promise<never> {
  throw new Error('Unexpected regeneration request');
}

test('Session Guest invitation, grants, and revocation form one durable authority lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-collaboration-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const prepared = await authority.prepareCollaborationInvitation('root-1', {
      sessionId: 'session-1',
      grantKinds: ['session_observation', 'session_turn_request'],
    });
    const invitation = decodeCollaborationInvitationCode(prepared.invitationCode);

    assert.deepEqual(authority.authenticate(invitation.credential)?.operationGrants, [
      'host.status',
      'access.credential.finalize',
    ]);
    const credentialId = authority.authenticate(invitation.credential)?.credentialId;
    assert.ok(credentialId);
    await authority.finalize(credentialId, 'guest-client', false);
    const activeGuest = authority.authenticate(invitation.credential);
    assert.deepEqual(activeGuest?.operationGrants, [
      'host.status',
      'artifact.query',
      'collaboration.turn-request.create',
      'collaboration.turn-request.acknowledge',
      'collaboration.turn-request.query',
      'collaboration.turn-request.withdraw',
      'runtime.resource.query',
      'session.shared.query',
      'subscription.open',
      'subscription.close',
      'session.transcript.page',
      'session.transcript.overlay.release',
      'access.credential.finalize',
    ]);
    assert.ok(activeGuest);
    const unidentifiedQuery = queryCollaborationTurnRequests(
      authority,
      { principalId: activeGuest.principalId, principalKind: undefined },
      { sessionId: 'session-1' },
    );
    assert.equal(unidentifiedQuery.ok, false);
    if (!unidentifiedQuery.ok) assert.equal(unidentifiedQuery.error.code, 'operation_unavailable');
    assert.equal(
      authorizeRuntimeHostOperation(activeGuest, {
        requestId: 'request-1',
        operation: 'collaboration.turn-request.create',
        input: {
          intent: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            content: { text: 'Continue' },
          },
        },
      } as RequestFrame),
      true,
    );
    assert.equal(
      authorizeRuntimeHostOperation(activeGuest, {
        requestId: 'request-2',
        operation: 'turn.start',
        input: {},
      } as RequestFrame),
      false,
    );

    const observation = prepared.grants.find((grant) => grant.kind === 'session_observation')!;
    assert.equal(
      authority.activeSessionGrant(prepared.principalId, 'session-1', 'session_observation')
        ?.grantId,
      observation.grantId,
    );
    assert.equal(
      (
        await authority.revokeCollaborationGrant({
          grantId: observation.grantId,
        })
      ).revoked,
      true,
    );
    assert.equal(
      authority.activeSessionGrant(prepared.principalId, 'session-1', 'session_observation'),
      undefined,
    );

    assert.deepEqual(await authority.revokeCollaborationPrincipal(prepared.principalId), {
      revoked: true,
    });
    assert.equal(authority.authenticate(invitation.credential), undefined);
    assert.equal(authority.queryCollaborationAccess({ sessionId: 'session-1' }).grants.length, 0);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Turn requests reject execution input that the Owner cannot review', () => {
  assert.deepEqual(
    HOST_OPERATION_SPECS['collaboration.turn-request.create'].decodeInput({
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-regenerated',
        sourceTurnId: 'turn-original',
      },
    }),
    {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-regenerated',
        sourceTurnId: 'turn-original',
      },
    },
  );
  assert.throws(
    () =>
      HOST_OPERATION_SPECS['collaboration.turn-request.create'].decodeInput({
        intent: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          content: { text: 'Looks harmless' },
          skillSelection: { mode: 'all' },
        },
      }),
    /Unknown Session Turn start request intent field/u,
  );
});

test('a Guest can withdraw only its own pending Turn request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-withdraw-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const otherPrincipalId = await activateTurnGuest(authority);
    const request = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-withdrawn',
        content: { text: 'Do not run this' },
      },
    });

    assert.deepEqual(
      await authority.withdrawTurnAccessRequest(otherPrincipalId, {
        requestId: request.requestId,
      }),
      { withdrawn: false },
    );
    assert.deepEqual(
      await authority.withdrawTurnAccessRequest(principalId, { requestId: request.requestId }),
      { withdrawn: true },
    );
    assert.equal(
      authority.queryTurnAccessRequests(LOCAL_OWNER, { sessionId: 'session-1' }).requests.length,
      0,
    );

    const approved = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-approved',
        content: { text: 'Run this' },
      },
    });
    await authority.decideTurnAccessRequest('local_owner', {
      requestId: approved.requestId,
      decision: 'approve',
    });
    assert.deepEqual(
      await authority.withdrawTurnAccessRequest(principalId, { requestId: approved.requestId }),
      { withdrawn: false },
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Owner can query one durable Turn-request inbox without exposing another Guest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-inbox-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    assert.deepEqual(HOST_OPERATION_SPECS['collaboration.turn-request.query'].decodeInput({}), {});
    const firstGuest = await activateTurnGuest(authority, 'session-1');
    const secondGuest = await activateTurnGuest(authority, 'session-2');
    await authority.createTurnAccessRequest(firstGuest, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: { text: 'First request' },
      },
    });
    await authority.createTurnAccessRequest(secondGuest, {
      intent: {
        sessionId: 'session-2',
        turnId: 'turn-2',
        content: { text: 'Second request' },
      },
    });

    assert.deepEqual(
      authority
        .queryTurnAccessRequests(LOCAL_OWNER, {})
        .requests.map((request) => request.intent.sessionId),
      ['session-1', 'session-2'],
    );
    assert.deepEqual(
      authority
        .queryTurnAccessRequests(sessionGuest(firstGuest), {})
        .requests.map((request) => request.intent.sessionId),
      ['session-1'],
    );
    assert.deepEqual(
      authority
        .queryTurnAccessRequests(LOCAL_OWNER, { sessionId: 'session-2' })
        .requests.map((request) => request.intent.sessionId),
      ['session-2'],
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an approved exact Turn request survives restart and is admitted once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-'));
  let authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const intent = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: { text: 'Run the approved task' },
    };
    const request = await authority.createTurnAccessRequest(principalId, {
      intent,
    });
    const decision = await authority.decideTurnAccessRequest('local_owner', {
      requestId: request.requestId,
      decision: 'approve',
    });
    assert.equal(decision.kind, 'decided');
    assert.equal(decision.kind, 'decided');
    if (decision.kind !== 'decided') assert.fail('Expected an approved request');
    assert.equal(decision.request.state.kind, 'approved');
    if (decision.request.state.kind !== 'approved') assert.fail('Expected an approved request');
    await authority.close();

    authority = await openRuntimeHostAccessAuthority(directory);
    const admitted: unknown[] = [];
    const authorizations: unknown[] = [];
    const coordinator = new SessionTurnAccessRequestCoordinator({
      authority,
      hostEpoch: 'epoch-1',
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => undefined,
      whenIdle: () => undefined,
      startTurn: async (input, context) => {
        admitted.push(input);
        authorizations.push(context.turnAdmissionAuthorization);
        return {
          ok: true,
          result: {
            kind: 'blocked',
            skillInvocation: { loaded: [], failed: [], receipts: [] },
          },
        };
      },
      regenerateTurn: unexpectedRegenerateTurn,
    });
    await coordinator.recover();
    await coordinator.close();

    assert.deepEqual(admitted, [intent]);
    assert.deepEqual(authorizations, [
      {
        kind: 'session_turn_access_request',
        requestId: request.requestId,
        principalId,
        grantId: request.grantId,
        approvedAt: Date.parse(decision.request.state.decidedAt),
        approvedBy: 'local_owner',
      },
    ]);
    const completed = authority.queryTurnAccessRequests(LOCAL_OWNER, {
      sessionId: 'session-1',
    }).requests[0];
    assert.equal(
      completed?.state.kind === 'approved' ? completed.state.admission : undefined,
      'blocked',
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an approved regeneration request uses the same durable admission boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-regenerate-request-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const intent = {
      sessionId: 'session-1',
      turnId: 'turn-regenerated',
      sourceTurnId: 'turn-original',
    };
    const request = await authority.createTurnAccessRequest(principalId, { intent });
    const equivalent = await authority.createTurnAccessRequest(principalId, {
      intent: { ...intent, turnId: 'another-client-attempt' },
    });
    assert.equal(equivalent.requestId, request.requestId);
    await authority.decideTurnAccessRequest('local_owner', {
      requestId: request.requestId,
      decision: 'approve',
    });
    const admitted: unknown[] = [];
    const coordinator = new SessionTurnAccessRequestCoordinator({
      authority,
      hostEpoch: 'epoch-1',
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => undefined,
      whenIdle: () => undefined,
      startTurn: async () => {
        throw new Error('Regeneration must not use turn.start');
      },
      regenerateTurn: async (input) => {
        admitted.push(input);
        return {
          ok: true,
          result: {
            sessionId: input.sessionId,
            turnId: input.turnId,
            runId: 'run-regenerated',
            status: 'running',
          },
        };
      },
    });
    coordinator.recover();
    await coordinator.close();

    assert.deepEqual(admitted, [intent]);
    const completed = authority.queryTurnAccessRequests(LOCAL_OWNER, {
      sessionId: 'session-1',
    }).requests[0];
    assert.equal(
      completed?.state.kind === 'approved' ? completed.state.admission : undefined,
      'started',
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Turn access request creation is idempotent for one exact Guest intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-idempotent-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const intent = {
      sessionId: 'session-1',
      turnId: 'stable-turn',
      content: { text: 'Run this once' },
    };
    const created = await authority.createTurnAccessRequest(principalId, { intent });
    assert.deepEqual(await authority.createTurnAccessRequest(principalId, { intent }), created);
    assert.equal(
      authority.queryTurnAccessRequests(sessionGuest(principalId), { sessionId: 'session-1' })
        .requests.length,
      1,
    );
    await assert.rejects(
      authority.createTurnAccessRequest(principalId, {
        intent: { ...intent, content: { text: 'Different work' } },
      }),
      /different intent/u,
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Turn access request results remain until acknowledged without consuming unbounded state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-bound-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const rejectedIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const request = await authority.createTurnAccessRequest(principalId, {
        intent: {
          sessionId: 'session-1',
          turnId: `rejected-${index}`,
          content: { text: `Rejected ${index}` },
        },
      });
      await authority.decideTurnAccessRequest('local_owner', {
        requestId: request.requestId,
        decision: 'reject',
      });
      rejectedIds.push(request.requestId);
    }
    await assert.rejects(
      authority.createTurnAccessRequest(principalId, {
        intent: {
          sessionId: 'session-1',
          turnId: 'unacknowledged-overflow',
          content: { text: 'Review the earlier results first' },
        },
      }),
      /Review earlier Turn access request results/u,
    );
    assert.deepEqual(
      authority
        .queryTurnAccessRequests(sessionGuest(principalId), { sessionId: 'session-1' })
        .requests.map((request) => request.requestId),
      rejectedIds,
    );
    assert.deepEqual(
      await authority.acknowledgeTurnAccessRequest(principalId, { requestId: rejectedIds[0]! }),
      { acknowledged: true },
    );
    assert.equal(
      authority.queryTurnAccessRequests(sessionGuest(principalId), { sessionId: 'session-1' })
        .requests.length,
      3,
    );
    const replacement = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'pending-after-acknowledgement',
        content: { text: 'Acknowledged history no longer blocks new work' },
      },
    });
    assert.equal(replacement.state.kind, 'pending');

    const otherPrincipal = await activateTurnGuest(authority);
    for (let index = 0; index < 3; index += 1) {
      await authority.createTurnAccessRequest(otherPrincipal, {
        intent: {
          sessionId: 'session-1',
          turnId: `pending-${index}`,
          content: { text: `Pending ${index}` },
        },
      });
    }
    await assert.rejects(
      authority.createTurnAccessRequest(otherPrincipal, {
        intent: {
          sessionId: 'session-1',
          turnId: 'pending-overflow',
          content: { text: 'Pending overflow' },
        },
      }),
      /Too many Turn access requests/u,
    );
    assert.equal(
      authority
        .queryTurnAccessRequests(sessionGuest(principalId), { sessionId: 'session-1' })
        .requests.every((request) => request.principalId === principalId),
      true,
    );
    assert.equal(
      authority
        .queryTurnAccessRequests(LOCAL_OWNER, { sessionId: 'session-1' })
        .requests.some((request) => request.principalId === otherPrincipal),
      true,
    );
    await authority.revokeCollaborationPrincipal(otherPrincipal);
    assert.equal(
      authority
        .queryTurnAccessRequests(LOCAL_OWNER, { sessionId: 'session-1' })
        .requests.some((request) => request.principalId === otherPrincipal),
      false,
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an uncertain access decision is recovered without premature Turn admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-uncertain-'));
  let failAfterWrite = false;
  let authority = await openRuntimeHostAccessAuthority(directory, {
    writeFile: async (path, file) => {
      await writeAccessCredentialFile(path, file);
      if (failAfterWrite) throw new RuntimeHostAccessCommitOutcomeUnknownError(new Error('fsync'));
    },
  });
  try {
    const principalId = await activateTurnGuest(authority);
    const request = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: { text: 'Run once durable' },
      },
    });
    const published: string[] = [];
    authority.subscribeApprovedTurnAccessRequests((changed) => published.push(changed.requestId));

    failAfterWrite = true;
    await assert.rejects(
      authority.decideTurnAccessRequest('local_owner', {
        requestId: request.requestId,
        decision: 'approve',
      }),
      RuntimeHostAccessCommitOutcomeUnknownError,
    );
    assert.deepEqual(published, []);
    await authority.close();

    authority = await openRuntimeHostAccessAuthority(directory);
    assert.equal(authority.approvedTurnAccessRequests().length, 1);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery stays ready while an approved Turn request waits for the Session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-busy-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const request = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-after-active-root',
        content: { text: 'Start when the current Turn finishes' },
      },
    });
    await authority.decideTurnAccessRequest('local_owner', {
      requestId: request.requestId,
      decision: 'approve',
    });

    let attempts = 0;
    let drained = false;
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    let observeSecondAttempt!: () => void;
    const secondAttempt = new Promise<void>((resolve) => {
      observeSecondAttempt = resolve;
    });
    const coordinator = new SessionTurnAccessRequestCoordinator({
      authority,
      hostEpoch: 'epoch-1',
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => {
        drained = true;
      },
      whenIdle: () => idle,
      startTurn: async () => {
        attempts += 1;
        if (attempts === 2) observeSecondAttempt();
        return attempts === 1
          ? {
              ok: false,
              error: {
                code: 'session_busy',
                message: 'Session already has an active root Turn',
                retryable: true,
              },
            }
          : {
              ok: true,
              result: {
                kind: 'blocked',
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              },
            };
      },
      regenerateTurn: unexpectedRegenerateTurn,
    });
    coordinator.recover();
    assert.equal(attempts, 1);
    releaseIdle();
    await secondAttempt;
    await coordinator.close();

    assert.equal(attempts, 2);
    assert.equal(drained, false);
    const completed = authority.queryTurnAccessRequests(LOCAL_OWNER, {
      sessionId: 'session-1',
    }).requests[0];
    assert.equal(
      completed?.state.kind === 'approved' ? completed.state.admission : undefined,
      'blocked',
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an idle-wait failure drains without losing the approved Turn request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-idle-failure-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    const request = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-after-failed-root',
        content: { text: 'Retry after Host recovery' },
      },
    });
    await authority.decideTurnAccessRequest('local_owner', {
      requestId: request.requestId,
      decision: 'approve',
    });

    let drained = false;
    const coordinator = new SessionTurnAccessRequestCoordinator({
      authority,
      hostEpoch: 'epoch-1',
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => {
        drained = true;
      },
      whenIdle: () => Promise.reject(new Error('active Turn authority failed')),
      startTurn: async () => ({
        ok: false,
        error: {
          code: 'session_busy',
          message: 'Session already has an active root Turn',
          retryable: true,
        },
      }),
      regenerateTurn: unexpectedRegenerateTurn,
    });
    coordinator.recover();
    await coordinator.close();

    assert.equal(drained, true);
    const pending = authority.queryTurnAccessRequests(LOCAL_OWNER, {
      sessionId: 'session-1',
    }).requests[0];
    assert.equal(
      pending?.state.kind === 'approved' ? pending.state.admission : undefined,
      'pending',
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('drain does not terminalize an in-flight admission failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-turn-request-drain-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const principalId = await activateTurnGuest(authority);
    let finishAdmission!: (result: {
      ok: false;
      error: { code: 'host_draining'; message: string; retryable: boolean };
    }) => void;
    const admission = new Promise<{
      ok: false;
      error: { code: 'host_draining'; message: string; retryable: boolean };
    }>((resolve) => {
      finishAdmission = resolve;
    });
    let started!: () => void;
    const startObserved = new Promise<void>((resolve) => {
      started = resolve;
    });
    const coordinator = new SessionTurnAccessRequestCoordinator({
      authority,
      hostEpoch: 'epoch-1',
      acquireResidency: () => ({ release: () => undefined }),
      requestDrain: () => undefined,
      whenIdle: () => undefined,
      startTurn: async () => {
        started();
        return admission;
      },
      regenerateTurn: unexpectedRegenerateTurn,
    });
    const request = await authority.createTurnAccessRequest(principalId, {
      intent: {
        sessionId: 'session-1',
        turnId: 'turn-during-drain',
        content: { text: 'Retry after restart' },
      },
    });
    await authority.decideTurnAccessRequest('local_owner', {
      requestId: request.requestId,
      decision: 'approve',
    });
    await startObserved;
    coordinator.beginDrain();
    finishAdmission({
      ok: false,
      error: {
        code: 'host_draining',
        message: 'Runtime Host is draining',
        retryable: true,
      },
    });
    await coordinator.close();

    const retained = authority.queryTurnAccessRequests(LOCAL_OWNER, {
      sessionId: 'session-1',
    }).requests[0];
    assert.equal(retained?.state.kind, 'approved');
    assert.equal(
      retained?.state.kind === 'approved' ? retained.state.admission : undefined,
      'pending',
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function activateTurnGuest(
  authority: RuntimeHostAccessAuthority,
  sessionId = 'session-1',
): Promise<string> {
  const prepared = await authority.prepareCollaborationInvitation('root-1', {
    sessionId,
    grantKinds: ['session_turn_request'],
  });
  const invitation = decodeCollaborationInvitationCode(prepared.invitationCode);
  const credentialId = authority.authenticate(invitation.credential)?.credentialId;
  assert.ok(credentialId);
  await authority.finalize(credentialId, 'guest-client', false);
  return prepared.principalId;
}
