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

import type { SessionStatus } from '@maka/core/session';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { deriveComposerModelSwitchAvailability, type ComposerSlashCommandOption } from '@maka/ui';
import { desktopSlashCommandAvailability } from '../../../application/contracts/desktop-slash-command.js';
import type { getShellCopy } from '../../../locales/shell-copy.js';
import { desktopSlashCommandPresentation } from './slash-command-presentation.js';

type ShellAppCopy = ReturnType<typeof getShellCopy>['app'];

/**
 * The Composer controls the displayed Session's Turn holds, and why.
 *
 * Every "cannot change this mid-turn" gate reads `turnActive`, the same witness
 * Stop reads. Reading the persisted status instead left these toggles live
 * through the whole send→run-start window — long enough on a cold backend for a
 * mode change to land before the run registers and alter the execution config
 * of the Turn already sent.
 */
export function composerTurnGates(input: {
  activeId: string | undefined;
  /** The opened Session's catalog row has arrived. */
  sessionLoaded: boolean;
  sessionStatus: SessionStatus | undefined;
  turnActive: boolean;
  streamingLive: boolean;
  copy: ShellAppCopy;
}) {
  const { activeId, sessionStatus, turnActive, streamingLive, copy } = input;
  const running = Boolean(activeId) && turnActive;
  const waiting = Boolean(activeId) && sessionStatus === 'waiting_for_user';
  // Plan and orchestration write the same Session configuration, so everything
  // that holds one holds the other. There is no pending-keyed reason while a
  // toggle commits: the pending registries already swallow re-entrant toggles,
  // and a reason would gray the row mid-click — the blink this control had.
  const modeChangeDisabledReason = activeId && !input.sessionLoaded
    ? copy.modeChangeLoading
    : streamingLive
      ? copy.modeChangeStreaming
      : running
        ? copy.modeChangeRunning
        : waiting
          ? copy.modeChangeWaiting
          : undefined;
  return {
    // #646: Stop must be available for the WHOLE turn - the moment the user
    // most wants to interrupt is a long wait with nothing on screen (first
    // token, or a slow provider's step-to-step lull).
    streaming: turnActive,
    modelSwitchAvailability: deriveComposerModelSwitchAvailability({
      streaming: turnActive,
      sessionStatus,
      pending: false,
    }),
    planModeDisabledReason: modeChangeDisabledReason,
    orchestrationModeDisabledReason: modeChangeDisabledReason,
    permissionModeDisabledReason: streamingLive
      ? copy.permissionModeStreaming
      : running
        ? copy.permissionModeRunning
        : waiting
          ? copy.permissionModeWaiting
          : undefined,
    goalDisabledReason: streamingLive || running ? copy.goalTurnActive : undefined,
  };
}

/** The catalog commands the Desktop Composer offers for this Session and Turn. */
export function desktopComposerSlashCommands(
  hasSession: boolean,
  streaming: boolean,
  copy: ShellAppCopy['slashCommands'],
): readonly ComposerSlashCommandOption[] {
  const presentation = desktopSlashCommandPresentation(copy);
  return slashCommandsForSurface('desktop')
    .filter(desktopSlashCommandAvailability({ hasSession, streaming }))
    .map(({ id }) => ({ id, ...presentation[id] }));
}
