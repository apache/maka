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
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ContinuationClaimV1,
} from '@maka/core/runtime-boundary';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { createMatterStore } from '../assistant/proactive-matters/store.js';
import { buildMatterTools } from '../assistant/proactive-matters/tools.js';
import {
  matterInput,
  deliveredMatterInput,
  readMatterRuntimeEvents,
} from '../assistant/proactive-matters/settlement-context.js';

for (const amend of [false, true]) {
  test(`handoff settlement reads inherited Inbox and rejects stale input: amended=${amend}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'matter-handoff-'));
    const db = join(dir, 'runtime.sqlite');
    let runtime = createSqliteRuntimeStore(db);
    const store = createMatterStore(join(dir, 'matter'));
    t.after(() => {
      runtime.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const m = store.create({
      cwd: dir,
      sessionId: 'worker',
      title: 'Delivery',
      request: 'Receive and inspect delivery',
    });
    const active = store.claim(m.id)!.matter;
    store.bindTurn(m.id, active.activation!.id, 'turn');
    const identity = { sessionId: 'worker', runId: 'root', invocationId: 'root', turnId: 'turn' };
    let source = buildInvocationOpenedEvent({
      id: 'root-open',
      run: identity,
      openedAt: 1,
      opening: {
        kind: 'invocation_opened',
        protocol: 'invocation_opened_v1',
        route: {
          provenance: 'runtime',
          backendKind: 'ai-sdk',
          llmConnectionId: 'test',
          llmConnectionSlug: 'test',
          modelId: 'controlled',
        },
        configuration: {
          cwd: dir,
          permissionMode: 'bypass',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          toolMode: DEFAULT_TOOL_MODE,
        },
        root: { kind: 'user' },
        source: { kind: 'fresh' },
      },
    });
    const append = async (e: RuntimeEvent) => runtime.appendRuntimeEvent(e.sessionId, e.runId, e);
    await append(source);
    const inbox = (id: string, run = source): RuntimeEvent => ({
      ...run,
      id,
      ts: 2,
      actions: undefined,
      modelVisibility: undefined,
      role: 'system',
      author: 'host',
      content: {
        kind: 'text',
        runtimeContextName: 'proactive-matters.inbox',
        text: 'Task inputs\n' + JSON.stringify(matterInput(store.get(m.id))),
      },
    });
    await append(inbox('delivered-root'));
    const segments: ReturnType<typeof runtimePrefixSegment>[] = [];
    for (let i = 1; i <= 2; i++) {
      const target = { ...identity, runId: 'successor-' + i, invocationId: 'successor-' + i };
      const claimId = 'claim-' + i;
      await append({
        ...source,
        id: 'seal-' + i,
        ts: 10 + i,
        content: undefined,
        actions: {
          endInvocation: true,
          handoffPause: {
            protocol: 'runtime_handoff_pause_v1',
            handoffId: 'handoff-' + i,
            hostEpoch: 'host',
            rootRunId: 'root',
            successorRunId: target.runId,
            successorInvocationId: target.invocationId,
            claimId,
            remainingSteps: null,
          },
        },
      });
      segments.push(
        runtimePrefixSegment(
          await runtime.readImmutableRuntimePrefix({ sessionId: 'worker', runId: source.runId }),
        ),
      );
      const boundary = createRuntimeBoundaryCursor(
        segments as [(typeof segments)[number], ...typeof segments],
      );
      const last = segments.at(-1)!;
      const opening = source.content as ContinuationClaimV1['targetOpening'];
      const claim: ContinuationClaimV1 = {
        protocol: 'continuation_claim_v1',
        claimId,
        boundary,
        boundaryDigest: boundary.manifestDigest,
        providerProjectionVersion: 1,
        providerReplayDigest: `sha256:${'a'.repeat(64)}`,
        target,
        claimedAt: 12 + i,
        targetOpening: {
          ...opening,
          source: {
            kind: 'handoff',
            rootRunId: 'root',
            claimId,
            boundaryDigest: boundary.manifestDigest,
            sourceInvocationId: source.invocationId,
            sourceRunId: source.runId,
            sourceTurnId: source.turnId,
            sourceRuntimeEventHighWater: last.position.lastEventSeq,
          },
        },
      };
      await runtime.claimContinuation({ claim });
      source = continuationStartEvent(claim, { id: 'start-' + i });
      await runtime.commitContinuationStart({ claim, event: source });
    }
    // Reopen the actual ledger: no in-memory inheritance or whole-session fallback.
    runtime.close();
    runtime = createSqliteRuntimeStore(db);
    assert.equal(
      (await runtime.readRuntimeEvents('worker', source.runId)).some(
        (e) => e.content?.kind === 'text',
      ),
      false,
    );
    const call: any = {
      sessionId: 'worker',
      turnId: 'turn',
      runId: source.runId,
      toolCallId: 'settle',
      abortSignal: new AbortController().signal,
      cwd: dir,
    };
    const toolEvent = (id: string): RuntimeEvent => ({
      ...source,
      id: 'event-' + id,
      ts: 30,
      actions: undefined,
      modelVisibility: undefined,
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id, name: 'MatterSettle', args: {} },
    });
    await append(toolEvent(call.toolCallId));
    let reviews = 0;
    const settle = buildMatterTools({
      store,
      changed() {},
      deliveredInput: async (c) =>
        deliveredMatterInput(await readMatterRuntimeEvents(runtime, c.sessionId, c.runId!), c),
      review: async () => {
        reviews++;
        return { approved: true, feedback: 'verified' };
      },
    }).find((t) => t.name === 'MatterSettle')!;
    const submit = async () =>
      settle.impl({ disposition: 'complete', summary: 'Delivery received and inspected.' }, call);
    if (amend) {
      store.ingest(m.id, { source: 'user', text: 'Also inspect packaging', key: 'amend' });
      // Even context arriving after this tool call must not authorize the old call.
      await append(inbox('new-input-after-call'));
      assert.equal(((await submit()) as any).code, 'MATTER_REVIEW_INVALIDATED');
      assert.equal(reviews, 0);
      call.toolCallId = 'settle-fresh';
      await append(toolEvent(call.toolCallId));
    }
    const untrusted = new Proxy(runtime, {
      get(target, key) {
        if (key === 'readContinuationClaimStateByBoundary') return async () => undefined;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      readMatterRuntimeEvents(untrusted, 'worker', source.runId),
      /without its continuation claim/,
    );
    const result: any = await submit();
    assert.equal(result.status, 'completed');
    assert.equal(reviews, 1);
    // A same-turn orphan run cannot borrow another run's Inbox.
    const orphan = {
      ...source,
      id: 'orphan-open',
      runId: 'orphan',
      invocationId: 'orphan',
      actions: undefined,
      content: {
        ...(source.content as ContinuationClaimV1['targetOpening']),
        source: { kind: 'fresh' as const },
      },
    };
    await assert.rejects(append(orphan), /continuation target identity conflict/);
    assert.deepEqual(await readMatterRuntimeEvents(runtime, 'another-session', source.runId), []);
  });
}

function continuationStartEvent(
  claim: ContinuationClaimV1,
  overrides: {
    id?: string;
    provenance?: 'runtime_admission' | 'claim_repair';
    toolBoundaryProtocol?: 't1_after_preflight_v1';
  } = {},
): RuntimeEvent {
  const source = claim.boundary.segments.at(-1)!;
  return {
    id: overrides.id ?? 'continuation-start-1',
    ...claim.target,
    ts: claim.claimedAt,
    partial: false,
    role: 'system',
    author: 'system',
    modelVisibility: 'hidden',
    content: claim.targetOpening,
    actions: {
      ...(overrides.toolBoundaryProtocol
        ? { runtimeProtocol: { toolBoundary: overrides.toolBoundaryProtocol } }
        : {}),
      continuationStart: {
        protocol: 'continuation_start_v2',
        provenance: overrides.provenance ?? 'runtime_admission',
        claimId: claim.claimId,
        boundaryDigest: claim.boundaryDigest,
        immediateSource: {
          sessionId: source.identity.sessionId,
          invocationId: source.identity.invocationId,
          runId: source.identity.runId,
          turnId: source.identity.turnId,
          highWater: source.position.lastEventSeq,
          prefixDigest: source.prefixDigest,
        },
        replayManifestDigest: claim.boundary.manifestDigest,
        providerProjectionVersion: claim.providerProjectionVersion,
        providerReplayDigest: claim.providerReplayDigest,
      },
    },
  };
}
