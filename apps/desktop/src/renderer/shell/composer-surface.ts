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

import type { NavSelection } from '@maka/ui';

type Current<T> = { readonly current: T };

export interface ComposerImportOwner {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
}

/** Shell-owned refs remain live; the draft key belongs to this render's target. */
export function createComposerSurfaceAuthority({
  activeIdRef,
  navSelectionRef,
  isSessionSelected,
  newTaskDraftKey,
}: {
  activeIdRef: Current<string | undefined>;
  navSelectionRef: Current<NavSelection>;
  isSessionSelected: (sessionId: string | undefined) => boolean;
  newTaskDraftKey: string;
}) {
  function captureComposerImportOwner(): ComposerImportOwner {
    return {
      sessionId: activeIdRef.current,
      navSection: navSelectionRef.current.section,
      ...(activeIdRef.current === undefined ? { newTaskDraftKey } : {}),
    };
  }

  // Navigation does not clear the active Session, so both identities matter.
  function isShellSurfaceOwnerActive(owner: ComposerImportOwner): boolean {
    return navSelectionRef.current.section === owner.navSection &&
      isSessionSelected(owner.sessionId) &&
      (owner.sessionId !== undefined || owner.newTaskDraftKey === newTaskDraftKey);
  }

  function isComposerImportOwnerActive(owner: ComposerImportOwner): boolean {
    return owner.navSection === 'sessions' && isShellSurfaceOwnerActive(owner);
  }

  function isNewChatSendSurfaceActive(owner: ComposerImportOwner): boolean {
    return owner.sessionId === undefined && isComposerImportOwnerActive(owner);
  }

  return {
    captureComposerImportOwner,
    isShellSurfaceOwnerActive,
    isComposerImportOwnerActive,
    isNewChatSendSurfaceActive,
  };
}

export function captureActiveComposerClaim(
  activeIdRef: Current<string | undefined>,
  navSelectionRef: Current<NavSelection>,
  composerRef: Current<{ appendText(text: string): void } | null>,
) {
  const sessionId = activeIdRef.current;
  const composer = composerRef.current;
  if (!sessionId || !composer || navSelectionRef.current.section !== 'sessions') return undefined;
  return {
    isCurrent: () =>
      activeIdRef.current === sessionId &&
      navSelectionRef.current.section === 'sessions' &&
      composerRef.current === composer,
    append: (text: string) => composer.appendText(text),
  };
}
