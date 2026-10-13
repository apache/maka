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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanProposal, PlanSessionState } from '@maka/core/plan';
import type { SessionEvent } from '@maka/core/events';
import { useToast, useUiLocale } from '@maka/ui';
import { reportUnexpectedError } from '../../../application/contracts/operation-diagnostics.js';
import type { PlanControlIpcResult } from '../../../../shared/plan-mode-ipc.js';
import { getPlanModeCopy, planControlFailureCopy } from '../../../locales/plan-mode-copy.js';
import type { PlanAutomaticQueryGate, PlanModeState, PlanSession } from '../model/plan-state.js';
import { usePlanServices } from '../plan-services.js';

/**
 * Identity of the panel instance a read or a user action belongs to.
 *
 * Switching Session installs a new object, so a late response can no longer
 * publish state, error or pending for the Session the user left — the read
 * sequence alone cannot do that, because an expired action resolving late would
 * otherwise claim the newest sequence for its own Session and overwrite the
 * panel the user is actually looking at. Within one object `sequence` supersedes
 * the reads started by an earlier effect run, so only the newest read of the
 * current Session wins.
 */
interface PlanPanelScope {
  readonly sessionId: string | undefined;
  sequence: number;
}

/**
 * The Plan control inputs a retry has to replay unchanged.
 *
 * The Host reconciles a retried control through its operation receipt, and the
 * receipt only matches while the recorded input — including the Turn the
 * operation was opened under — is unchanged. A retry therefore reuses this
 * record instead of re-deriving it from Plan state that has moved on, which is
 * exactly the case where the expected store version is stale by the time the
 * user retries.
 */
interface PlanApprovalRetry {
  sessionId: string;
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion: number;
  turnId: string;
}

interface PlanResumeRetry {
  sessionId: string;
  executionId: string;
  turnId: string;
}

/** One slot per Plan control, so the panel needs a single retry ref. */
interface PlanControlRetries {
  approval?: PlanApprovalRetry;
  resume?: PlanResumeRetry;
}

const UNBLOCKED_QUERY_GATE: PlanAutomaticQueryGate = {
  subscribe: () => () => undefined,
  isAutomaticQueryBlocked: () => false,
};

export function usePlanModeState(
  session: PlanSession | undefined,
  automaticQueryGate: PlanAutomaticQueryGate = UNBLOCKED_QUERY_GATE,
): PlanModeState {
  const services = usePlanServices();
  const toastApi = useToast();
  const locale = useUiLocale();
  const copy = getPlanModeCopy(locale);
  const [state, setState] = useState<PlanSessionState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const retries = useRef<PlanControlRetries>({});

  // Session/lifecycle identity for this panel instance: a Session switch installs
  // a new scope, and the effect below supersedes the reads this scope started
  // when it is replaced. The switch is also the only thing that can strand the
  // pending indicator — the action that raised it owns the previous scope, so its
  // `finally` no longer clears this one — and clearing it here, while React is
  // already rendering the new Session, keeps that panel from rendering as busy.
  const scopeRef = useRef<PlanPanelScope>({ sessionId: session?.id, sequence: 0 });
  if (scopeRef.current.sessionId !== session?.id) {
    scopeRef.current = { sessionId: session?.id, sequence: 0 };
    setPending(false);
  }

  const refresh = useCallback(async (options: { automatic?: boolean } = {}) => {
    const { automatic = true } = options;
    if (!session) return;
    if (automatic && automaticQueryGate.isAutomaticQueryBlocked(session.id)) return;
    const owner = scopeRef.current;
    // A read belongs to the Session this render was made for, and must not even
    // claim a sequence for a Session the panel has already left — that would
    // supersede the newer Session's own in-flight read.
    if (owner.sessionId !== session.id) return;
    // Plan execution writes now refresh while the Turn runs, so reads can
    // overlap: only the newest read may publish, or a slower earlier response
    // puts stale progress back on screen.
    const sequence = (owner.sequence += 1);
    let next: PlanSessionState;
    try {
      next = await services.getPlanState(session.id);
    } catch (cause) {
      // A superseded read owns nothing, including its failure: report it only
      // while it is still the newest read of the Session still on screen.
      if (scopeRef.current !== owner || owner.sequence !== sequence) return;
      throw cause;
    }
    if (
      scopeRef.current !== owner
      || owner.sequence !== sequence
      || (automatic && automaticQueryGate.isAutomaticQueryBlocked(session.id))
    ) return;
    setState(next);
  }, [automaticQueryGate, services, session?.id]);

  useEffect(() => {
    const scope = scopeRef.current;
    setState(undefined);
    setError(undefined);
    if (!session) return;
    let queryBlocked = automaticQueryGate.isAutomaticQueryBlocked(session.id);
    const refreshOrReport = () => void refresh().catch((cause) => {
      if (queryBlocked) return;
      reportUnexpectedError('plan-mode:refresh', cause);
      setError(copy.operationFailed);
    });
    refreshOrReport();
    const unsubscribeQueryGate = automaticQueryGate.subscribe(() => {
      const next = automaticQueryGate.isAutomaticQueryBlocked(session.id);
      if (next === queryBlocked) return;
      queryBlocked = next;
      scope.sequence += 1;
      if (!queryBlocked) refreshOrReport();
    });
    const unsubscribeEvents = services.subscribeEvents(session.id, (event: SessionEvent) => {
      if (
        event.type === 'plan_submitted'
        || event.type === 'complete'
        || event.type === 'abort'
      ) {
        refreshOrReport();
      }
    });
    const unsubscribePlanChanges = services.subscribePlanChanges(
      session.id,
      refreshOrReport,
    );
    return () => {
      // Supersedes every read this run started: a Session switch, a close and an
      // unmount all pass through here, and the next effect refreshes again.
      scope.sequence += 1;
      unsubscribeQueryGate();
      unsubscribeEvents();
      unsubscribePlanChanges();
    };
  }, [automaticQueryGate, copy.operationFailed, services, session?.id, session?.collaborationMode, refresh]);

  const run = useCallback(
    async (
      owner: PlanPanelScope,
      action: () => Promise<PlanControlIpcResult<unknown>>,
    ): Promise<void> => {
      // Callers capture their scope before their first await — for `abandon`
      // that is before the confirmation dialog — so an action that resumes after
      // a Session switch never adopts the Session that replaced it. The
      // confirmation belonged to a panel the user has left, and the panel that
      // replaced it belongs to a Session nobody confirmed anything for, so the
      // action is dropped instead of applied.
      if (owner.sessionId === undefined || scopeRef.current !== owner) return;
      setPending(true);
      setError(undefined);
      try {
        const result = await action();
        if (scopeRef.current !== owner) return;
        if (!result.ok) {
          setError(planControlFailureCopy(result.error, copy));
          return;
        }
        await refresh({ automatic: false });
      } catch (cause) {
        if (scopeRef.current !== owner) return;
        reportUnexpectedError('plan-mode:action', cause);
        setError(copy.operationFailed);
      } finally {
        if (scopeRef.current === owner) setPending(false);
      }
    },
    [copy, refresh],
  );

  const requestRevision = useCallback(async (proposalId: string): Promise<void> => {
    if (!session) return;
    const owner = scopeRef.current;
    await run(owner, async () => {
      return services.requestPlanRevision(session.id, proposalId);
    });
  }, [run, services, session?.id]);

  const approve = useCallback(async (proposal: PlanProposal): Promise<void> => {
    if (!session || !state) return;
    const owner = scopeRef.current;
    const current = retries.current.approval;
    const input =
      current
      && current.sessionId === session.id
      && current.proposalId === proposal.proposalId
      && current.expectedRevision === proposal.revision
        ? current
        : {
            sessionId: session.id,
            proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
            expectedStoreVersion: state.storeVersion,
            turnId: crypto.randomUUID(),
          };
    retries.current.approval = input;
    await run(owner, async () => {
      const result = await services.approvePlan(session.id, {
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
        turnId: input.turnId,
      });
      // Only the request that stored this input may retire it: a response that
      // arrives after a newer request replaced the slot has to leave it alone, or
      // the newer retry loses the Turn id its receipt is keyed by and the Host
      // sees a second approval instead of a replay.
      if (result.ok && retries.current.approval === input) retries.current.approval = undefined;
      return result;
    });
  }, [run, services, session?.id, state]);

  const resume = useCallback(async (executionId: string): Promise<void> => {
    if (!session) return;
    const owner = scopeRef.current;
    const current = retries.current.resume;
    const input =
      current && current.sessionId === session.id && current.executionId === executionId
        ? current
        : { sessionId: session.id, executionId, turnId: crypto.randomUUID() };
    retries.current.resume = input;
    await run(owner, async () => {
      const result = await services.resumePlan(session.id, executionId, input.turnId);
      if (result.ok && retries.current.resume === input) retries.current.resume = undefined;
      return result;
    });
  }, [run, services, session?.id]);

  const abandon = useCallback(async (executionId: string, title: string): Promise<void> => {
    if (!session) return;
    // Captured before the confirmation: the dialog stays open across a Session
    // switch, and confirming it afterwards must not apply the abandon to the
    // Session that replaced the one the user was looking at.
    const owner = scopeRef.current;
    const confirmed = await toastApi.confirm({
      title: copy.abandonConfirmation.title,
      description: copy.abandonConfirmation.description(title),
      confirmLabel: copy.abandonConfirmation.confirm,
      cancelLabel: copy.abandonConfirmation.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    await run(owner, async () => {
      return services.abandonPlanExecution(session.id, executionId);
    });
  }, [copy, run, services, session?.id, toastApi]);

  return { state, pending, error, requestRevision, approve, resume, abandon };
}
