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

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useToast, useUiLocale, type ConfirmInput } from '@maka/ui';
import { unexpectedOperationFallback } from '@maka/core/redaction';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { getSessionWorkspaceRecoveryCopy } from '../locales/session-workspace-recovery-copy.js';
import { isReadyTaskEntryHost } from '../model/task-entry-selection.js';
import type { TaskEntryCatalog, TaskEntryError, TaskEntryHostRef } from '../ports.js';
import { useTaskEntryServices } from '../services-context.js';
import { resolveProjectRegistration } from './resolve-project-registration.js';

export interface SessionWorkspaceRecoveryRequest {
  readonly sessionId: string;
}

export interface RelocateSessionWorkspaceInput {
  sessionId: string;
  profileId: string;
  projectId: string;
  /** Fences callbacks retained by an older picker/dialog. */
  request?: SessionWorkspaceRecoveryRequest;
}

export interface AddSessionWorkspaceInput {
  sessionId: string;
  profileId: string;
  host: TaskEntryHostRef;
  name: string;
  request?: SessionWorkspaceRecoveryRequest;
}

interface Attempt {
  readonly host: TaskEntryHostRef;
  readonly adding: boolean;
  invalid: boolean;
}

function hostIsCurrent(catalog: TaskEntryCatalog, attempt: Attempt): boolean {
  return catalog.hosts.some((host) =>
    isReadyTaskEntryHost(host) &&
    host.profile.id === attempt.host.profileId && host.hostId === attempt.host.hostId &&
    (!attempt.adding || (host.profile.kind === 'local' && host.capabilities.chooseClientDirectory)),
  );
}

/** Recovery owns a Session intent, never the new-task Project selection. */
export function useSessionWorkspaceRecovery({
  catalog,
  catalogRef,
  mutationPendingRef,
  setPending,
  refresh,
  reportError,
  confirm,
}: {
  catalog: TaskEntryCatalog;
  catalogRef: RefObject<TaskEntryCatalog>;
  mutationPendingRef: RefObject<boolean>;
  setPending(pending: boolean): void;
  refresh(): Promise<unknown>;
  reportError(error: TaskEntryError): void;
  confirm?: (input: ConfirmInput) => Promise<boolean>;
}) {
  const { catalog: service, sessions } = useTaskEntryServices();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getSessionWorkspaceRecoveryCopy(locale);
  const projectCopy = getShellCopy(locale).projectActions;
  const moveCopy = getShellCopy(locale).sessionRowActions;
  const [sessionWorkspaceRecovery, setRecovery] = useState<SessionWorkspaceRecoveryRequest>();
  const requestRef = useRef<SessionWorkspaceRecoveryRequest | undefined>(undefined);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (attemptRef.current) attemptRef.current.invalid = true;
    };
  }, [service, sessions, locale]);

  useLayoutEffect(() => {
    const attempt = attemptRef.current;
    // Invalidation is monotonic: reconnecting to the same Host cannot revive it.
    if (attempt && !hostIsCurrent(catalog, attempt)) attempt.invalid = true;
  }, [catalog]);

  const openSessionWorkspaceRecovery = useCallback((sessionId: string): void => {
    if (attemptRef.current) attemptRef.current.invalid = true;
    const request = { sessionId };
    requestRef.current = request;
    setRecovery(request);
  }, []);

  const closeSessionWorkspaceRecovery = useCallback((expected?: SessionWorkspaceRecoveryRequest): void => {
    if (expected && expected !== requestRef.current) return;
    if (attemptRef.current) attemptRef.current.invalid = true;
    requestRef.current = undefined;
    setRecovery(undefined);
  }, []);

  const run = useCallback(async (input: AddSessionWorkspaceInput | RelocateSessionWorkspaceInput): Promise<boolean> => {
    const request = input.request ?? requestRef.current;
    if (!mounted.current || mutationPendingRef.current ||
      (input.request && input.request !== requestRef.current) ||
      (request && request.sessionId !== input.sessionId)) return false;
    const adding = 'host' in input;
    if (adding && (!request || input.host.profileId !== input.profileId)) return false;
    const host = catalogRef.current.hosts.find((candidate) =>
      candidate.profile.id === input.profileId && isReadyTaskEntryHost(candidate),
    );
    if (!host || !isReadyTaskEntryHost(host)) return false;
    const attempt: Attempt = {
      host: adding ? input.host : { profileId: input.profileId, hostId: host.hostId },
      adding,
      invalid: false,
    };
    if (!hostIsCurrent(catalogRef.current, attempt)) return false;
    const current = () => mounted.current && !attempt.invalid &&
      requestRef.current === request && hostIsCurrent(catalogRef.current, attempt);
    attemptRef.current = attempt;
    mutationPendingRef.current = true;
    setPending(true);
    const operation: { phase: 'register' | 'restore' | 'relocate' } = { phase: 'register' };
    let projectChanged = false;
    let restored = false;
    let moved = false;
    try {
      let projectId: string;
      if (adding) {
        const result = await resolveProjectRegistration({
          register: () => service.addProject(input.host, input.name),
          confirm: (onConfirm) => (confirm ?? toast.confirm)({
            onConfirm,
            title: projectCopy.archivedProjectTitle,
            description: copy.confirmDescription,
            confirmLabel: copy.confirmLabel,
            cancelLabel: projectCopy.archivedProjectCancel,
          }),
          restore: async (id) => {
            operation.phase = 'restore';
            const result = await service.restoreProject(input.host, id);
            restored = result.ok;
            projectChanged = result.ok;
            return result;
          },
          isCurrent: current,
        });
        if (!result?.ok || !current()) return false;
        projectChanged = true;
        if (!result.project.available || result.project.archivedAt !== undefined) {
          reportError({
            title: moveCopy.moveFailedTitle,
            description: `${restored ? `${copy.restoredPrefix} ` : ''}${copy.projectUnavailable}`,
            profileId: input.profileId,
          });
          return false;
        }
        projectId = result.project.id;
      } else {
        projectId = input.projectId;
      }
      operation.phase = 'relocate';
      // Even an unchanged Project must pass Runtime Host eligibility checks.
      const result = await sessions.relocateWorkspace(input.sessionId, projectId);
      if (!current()) return false;
      if (!result.ok) {
        reportError({
          title: moveCopy.moveFailedTitle,
          description: `${restored ? `${copy.restoredPrefix} ` : ''}${moveCopy.moveFailures[result.reason]}`,
          profileId: input.profileId,
        });
        return false;
      }
      moved = true;
      return true;
    } catch (cause) {
      if (current()) {
        // IPC rejection does not prove the write failed. Never automatically retry.
        const title = operation.phase === 'relocate' ? copy.moveUnconfirmedTitle
          : operation.phase === 'restore' ? copy.restoreUnconfirmedTitle : copy.registrationUnconfirmedTitle;
        const description = operation.phase === 'relocate' ? copy.moveUnconfirmed
          : operation.phase === 'restore' ? copy.restoreUnconfirmed : copy.registrationUnconfirmed;
        reportError({
          title,
          description: unexpectedOperationFallback(
            cause,
            `${restored ? `${copy.restoredPrefix} ` : ''}${description}`,
            'session-workspace-recovery',
          ),
          profileId: input.profileId,
        });
      }
      return false;
    } finally {
      // Catalog refresh is not part of the relocation commit. Its failure must
      // neither roll back a restored Project nor turn a successful move into failure.
      if (projectChanged && current()) {
        try {
          await refresh();
        } catch {
          if (current()) reportError({
            title: copy.refreshFailedTitle,
            description: copy.refreshFailed,
            profileId: input.profileId,
          });
        }
      }
      if (moved && current()) closeSessionWorkspaceRecovery(request);
      attemptRef.current = undefined;
      mutationPendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }, [catalogRef, closeSessionWorkspaceRecovery, confirm, copy, locale, moveCopy, mutationPendingRef, projectCopy, refresh, reportError, service, sessions, setPending, toast]);

  return {
    sessionWorkspaceRecovery,
    openSessionWorkspaceRecovery,
    closeSessionWorkspaceRecovery,
    addSessionWorkspace: run,
    relocateSessionWorkspace: run,
  };
}
