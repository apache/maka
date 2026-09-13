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

/**
 * Text extraction and localized copy for the `/copy` slash command.
 *
 * The transcript's user/assistant entries already hold plain markdown text (no
 * ANSI), so copy pulls straight from `state.entries` rather than stripping the
 * rendered projection. See `MakaPiTranscriptEntry` in `pi-transcript.ts`.
 */

import {
  defineUiMessageCatalog,
  resolveUiMessageCatalog,
  type UiLocale,
} from '@maka/core/ui-locale';
import { TUI_COPY_RESOURCES } from './tui-copy-catalog.js';
import type { MakaPiTranscriptState } from './pi-transcript.js';

export interface TuiCopyCopy {
  /** ICU: confirmation for `/copy` (last assistant reply). Takes `{count}`. */
  readonly copiedLast: string;
  /** ICU: confirmation for `/copy all` (whole conversation). Takes `{count}`. */
  readonly copiedAll: string;
  /** ICU: refusal when the payload exceeds the clipboard cap. Takes `{bytes}`, `{limit}`. */
  readonly tooLarge: string;
  /** Shown when there is nothing to copy yet. */
  readonly nothingToCopy: string;
  /** Shown when `/copy` receives an unsupported argument. */
  readonly usage: string;
  /** Role label for user turns in `/copy all`. */
  readonly roleUser: string;
  /** Role label for assistant turns in `/copy all`. */
  readonly roleAssistant: string;
  /** Provenance label for autonomous goal-continuation turns in `/copy all`. */
  readonly roleGoalContinuation: string;
  /** Provenance label for legacy-automation turns in `/copy all`. */
  readonly roleLegacyAutomation: string;
}

const TUI_COPY_COMMAND_COPY = resolveUiMessageCatalog(
  defineUiMessageCatalog<TuiCopyCopy>()(TUI_COPY_RESOURCES.copy),
);

export function getTuiCopyCopy(locale: UiLocale): TuiCopyCopy {
  return TUI_COPY_COMMAND_COPY[locale];
}

/**
 * The last assistant reply's plain text, or undefined if there is none yet.
 *
 * Empty assistant entries are skipped: a tool-only or aborted turn — and
 * durable recovery, which materializes an assistant entry per stored message
 * regardless of text — can leave a text-less entry at the tail that would
 * otherwise mask an earlier real reply.
 */
export function lastAssistantText(state: MakaPiTranscriptState): string | undefined {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (entry?.kind === 'assistant' && entry.text.trim() !== '') return entry.text;
  }
  return undefined;
}

/**
 * Serialize the whole conversation to plain text with role labels, in order.
 * Thinking, tool calls, and notices are omitted so the copy reads as the
 * conversation, not the machinery around it.
 *
 * `goal_continuation` and `legacy_automation` are non-user-triggered driving
 * turns (see `TurnOrigin` in `turn-origin.ts`) that the TUI renders with their
 * own provenance headers, so they carry distinct labels here rather than the
 * user label: relabeling them `You:` would misattribute autonomous prompts to
 * the human, and dropping them would both erase the prompts that drove a run and
 * merge the assistant turns on either side into one answer.
 *
 * Only *consecutive assistant* entries collapse under one label, so an assistant
 * turn whose text is split across several internal steps (e.g. text before and
 * after a tool call) reads as one `Maka:` block. Every non-assistant turn opens
 * its own block — two queued user messages, or two turns separated only by a
 * skipped text-less assistant entry, must not merge. Empty assistant steps are
 * dropped, and because a new block only ever opens for a non-assistant turn or a
 * fresh assistant run, that skip never joins the blocks around it.
 */
export function serializeTranscriptText(
  state: MakaPiTranscriptState,
  labels: {
    user: string;
    assistant: string;
    goalContinuation: string;
    legacyAutomation: string;
  },
): string {
  const blocks: { role: string; label: string; text: string }[] = [];
  for (const entry of state.entries) {
    let role: string;
    let label: string;
    switch (entry.kind) {
      case 'user':
        role = 'user';
        label = labels.user;
        break;
      case 'goal_continuation':
        role = 'goal_continuation';
        label = labels.goalContinuation;
        break;
      case 'legacy_automation':
        role = 'legacy_automation';
        label = labels.legacyAutomation;
        break;
      case 'assistant':
        if (entry.text.trim() === '') continue;
        role = 'assistant';
        label = labels.assistant;
        break;
      default:
        continue;
    }
    const last = blocks[blocks.length - 1];
    // Collapse only a running assistant turn's steps; every other turn is its own.
    if (role === 'assistant' && last?.role === 'assistant') last.text += `\n\n${entry.text}`;
    else blocks.push({ role, label, text: entry.text });
  }
  return blocks.map((block) => `${block.label}\n${block.text}`).join('\n\n');
}
