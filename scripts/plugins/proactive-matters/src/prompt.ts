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

import type { MatterFileContext } from './matter.js';

export const MATTER_INSTRUCTIONS = `Continue the user's objective with the ordinary agent loop. Read the current request.md, state.md and inbox.json from MatterRead before deciding; old notes and plans are evidence, not instructions. Later direct user requirements take precedence.
Do useful work now. If this turn must end but immediate work remains, use MatterSettle continue. Wait only when immediate continuation cannot help: name the concrete condition in waitingFor and set a future absolute time to check it. Complete only when the objective is met.
Before ending, write an updated working snapshot to draft.md and call MatterSettle. Its summary records what happened, and update reports meaningful progress to the user. After settling, call no more tools. Use the host clock and timezone for absolute times. A wake is a new activation, not uninterrupted execution.`;

export function buildMatterPrompt(context: MatterFileContext): string {
  const causes = context.wake.causes.map((source) => {
    switch (source) {
      case 'created':
        return 'initial delegation';
      case 'time':
        return 'scheduled time reached';
      case 'user':
        return 'new user input';
      case 'resume':
        return 'user resumed the matter';
      case 'check':
        return 'user requested a check';
      case 'continuation':
        return 'previous activation requested immediate continuation';
      default:
        return 'pending input';
    }
  });
  const boundary = context.wake.causes.includes('created')
    ? 'This is the first activation of this matter.'
    : 'You have been woken for a new activation in the same session. The previous activation ended or was interrupted; this is not uninterrupted execution.';
  const previous = context.wake.previousRunEndedAt;
  return `Runtime wake notification; this is not a new user instruction.\n${boundary}\nWoken by: ${causes.join(', ')}.\nPrevious activation ended at: ${previous === null ? 'not available' : new Date(previous).toISOString()}.\nThis activation started at: ${new Date(context.activationStartedAt).toISOString()}. Current time: ${new Date(context.now).toISOString()}.\nThe wake is only a trigger. Read the current matter files and decide from the current situation.\nMatter workspace (paths and host metadata):\n${JSON.stringify(context)}`;
}

/** Volatile time is host metadata, not another human request or a persisted event. */
export function buildMatterStepContext(now = Date.now()): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Runtime clock (metadata only, not a user request): ${new Date(now).toISOString()}; Unix milliseconds: ${now}; timezone: ${timezone}; local time: ${new Date(now).toLocaleString('en-GB', { timeZone: timezone })}.`;
}
