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

// The context use in the composer: how much of the model's input the
// conversation's newest request took (`agent.context`), as a ring and a
// percentage before Send, and a popover with what took it and Compact
// (`agent.compact`), which first shows the instruction it will send.
//
// The use is read when a conversation opens and each time one of its runs
// ends; a compaction is a run, so its end counts. main.js tells it which
// conversation the composer serves (`follow`) whenever the window changed.

import { div, PathBuilder } from 'gpui-kit';
import { v_flex, h_flex, Popover, Textarea, TextareaState } from 'gpui-base';
import { query, operation, log } from './host.js';
import { palette, typeset, text, ghostButton, menuSurface, controlButton } from './theme.js';
import { t, tn, onLanguageChange } from './locale.js';

/** Above these shares of the limit the ring turns to the warning, then the destructive color. */
const WARN_AT = 0.8;
const ALARM_AT = 0.95;

/** The prepared input's parts (`breakdown`), in the order the popover lists them. */
const BUCKETS = [
  ['system', 'contextSystem'],
  ['user', 'contextUser'],
  ['assistant', 'contextAssistant'],
  ['tool', 'contextTool'],
  ['toolSchemas', 'contextToolSchemas'],
];

/** Why the Host did not start a compaction (`AgentCompactRejection`), in words. */
const REJECTED = {
  busy: 'compactBusy',
  closed: 'compactClosed',
  archived: 'compactArchived',
  backend_unavailable: 'compactBackendUnavailable',
  workspace_changed: 'compactWorkspaceChanged',
};

export class ContextUse {
  /**
   * Creates retained input state, so it belongs in the view's `init`.
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   * @param {import("./composer.js").Composer} composer whose model a compaction runs with
   */
  constructor(hooks, composer) {
    this.hooks = hooks;
    this.composer = composer;
    /** The conversation the composer serves (a Transcript), or null. */
    this.transcript = null;
    /** How many of its runs had ended when it was last read. */
    this.runsEnded = 0;
    /** `agent.context`'s `request` for that conversation: its newest request, or null. */
    this.request = null;
    /** Sessions with a read under way, and those to read once more when it ends. */
    this.reading = new Set();
    this.again = new Set();
    /** Whether the popover is open. */
    this.open = false;
    /**
     * The confirmation before Compact, or null: `prompt` is the instruction
     * the Host would use (null while it is read), which the field starts with.
     * Left as it was, or emptied, the Host uses its own (the preference).
     */
    this.confirm = null;
    this.instruction = TextareaState.new({ rows: 7, placeholder: t('compactPromptPlaceholder') });
    this.instruction.set_soft_wrap(true);
    onLanguageChange(() => this.instruction.set_placeholder(t('compactPromptPlaceholder')));
    /** Whether `agent.compact` is under way. */
    this.compacting = false;
    /**
     * The last Compact the Host did not answer, `{ id, transcript, runsEnded }`,
     * or null: it may have started, so Compact waits (awaitingCompact).
     */
    this.unanswered = null;
  }

  /**
   * Takes the conversation the composer serves now. Another session is read
   * at once and its predecessor's report dropped; the same one is read again
   * when one of its runs ended since the last look. Cheap otherwise.
   */
  follow(transcript) {
    if (transcript !== this.transcript) {
      const same = transcript !== null && transcript.id === this.transcript?.id;
      this.transcript = transcript;
      this.open = false;
      this.confirm = null;
      if (!same) this.request = null;
      if (transcript === null) return;
      this.runsEnded = transcript.runsEnded;
      this.read(transcript);
      return;
    }
    if (transcript === null || transcript.runsEnded === this.runsEnded) return;
    this.runsEnded = transcript.runsEnded;
    this.read(transcript);
  }

  /**
   * Reads the context use of `transcript`'s session. One read per session
   * at a time: a call while one is under way reads once more after it. An
   * answer for a session the composer no longer serves is dropped.
   */
  async read(transcript) {
    const id = transcript.id;
    if (this.reading.has(id)) {
      this.again.add(id);
      return;
    }
    this.reading.add(id);
    try {
      do {
        this.again.delete(id);
        const report = await query(transcript.endpoint, 'context', {
          sessionId: id,
          through: null,
        });
        if (this.transcript?.id !== id) return;
        this.request = report.request ?? null;
        this.hooks.changed();
      } while (this.again.has(id) && this.transcript?.id === id);
    } catch (error) {
      // The ring keeps what it showed; it is read again when the next run ends.
      log(`context: reading ${id} failed: ${error.message}`);
    } finally {
      this.reading.delete(id);
      this.again.delete(id);
    }
  }

  setOpen(open) {
    this.open = open;
    if (!open) this.confirm = null;
    this.hooks.changed();
  }

  /**
   * Whether Compact can start: nothing runs in the conversation, its model
   * is one the desktop starts, and no unanswered Compact may still start.
   */
  canCompact() {
    const transcript = this.transcript;
    return (
      transcript !== null &&
      transcript.ready &&
      transcript.run === null &&
      transcript.backend?.kind !== 'executor' &&
      !this.compacting &&
      !this.awaitingCompact()
    );
  }

  /**
   * Whether Compact waits after a Compact the Host did not answer: until the
   * conversation shows a run start or end (a compaction is a run), or until
   * it is opened again (a new Transcript, once it has read its rows).
   */
  awaitingCompact() {
    const unanswered = this.unanswered;
    const transcript = this.transcript;
    if (unanswered === null || transcript === null || transcript.id !== unanswered.id) return false;
    if (transcript !== unanswered.transcript) return !transcript.ready;
    return transcript.run === null && transcript.runsEnded === unanswered.runsEnded;
  }

  /** Compact in the popover: shows the confirmation, with the instruction the Host would use. */
  async askCompact() {
    const transcript = this.transcript;
    if (transcript === null || !this.canCompact()) return;
    const confirm = { prompt: null };
    this.confirm = confirm;
    this.hooks.changed();
    try {
      const answer = await query(transcript.endpoint, 'compactionPrompt', {
        sessionId: transcript.id,
      });
      if (this.confirm !== confirm || this.transcript !== transcript) return;
      confirm.prompt = answer.compactionPrompt;
      this.instruction.set_value(answer.compactionPrompt);
    } catch (error) {
      if (this.confirm !== confirm) return;
      this.confirm = null;
      this.open = false;
      this.hooks.report(t('compactFailed', { value: error.message }));
    }
    this.hooks.changed();
  }

  /**
   * The instruction Compact sends: the field's text when it was changed to
   * some other text, else null (left as it was, or emptied: the Host uses
   * its own, the preference).
   */
  promptToSend() {
    const value = this.instruction.value();
    return value.trim() === '' || value === this.confirm?.prompt ? null : value;
  }

  /**
   * The confirmation's Compact: `agent.compact` with the composer's model,
   * and the instruction only when it was changed to some other text (left as
   * it was, or emptied, the Host uses its own). The compaction shows as a run
   * of the conversation. The Host does not recognize a Compact sent twice, so
   * one it did not answer is not sent again: the notice says the outcome is
   * unknown and Compact waits until the conversation shows a run
   * (awaitingCompact).
   */
  async compact() {
    const transcript = this.transcript;
    const confirm = this.confirm;
    if (transcript === null || confirm?.prompt == null || !this.canCompact()) return;
    const prompt = this.promptToSend();
    this.compacting = true;
    this.hooks.changed();
    try {
      const { model, thinkingLevel } = await this.composer.selection(transcript);
      let result;
      try {
        result = await operation(transcript.endpoint, 'compact', {
          sessionId: transcript.id,
          model,
          thinkingLevel,
          prompt,
        });
      } catch (error) {
        log(`context: compact of ${transcript.id} got no answer: ${error.message}`);
        this.unanswered = { id: transcript.id, transcript, runsEnded: transcript.runsEnded };
        this.open = false;
        this.confirm = null;
        this.hooks.report(t('compactUnknown'));
        return;
      }
      this.open = false;
      this.confirm = null;
      if (result.kind === 'rejected') {
        log(`context: compaction rejected: ${result.reason}`);
        this.hooks.report(
          t(REJECTED[result.reason] ?? 'compactRejected', { value: result.reason }),
        );
        return;
      }
      log(
        `context: compaction ${result.execution.invocationId} started${prompt === null ? '' : ' with a changed instruction'}`,
      );
      // The compaction's facts come through the watch; this shows it running now.
      await transcript.observeRun();
    } catch (error) {
      this.hooks.report(t('compactFailed', { value: error.message }));
    } finally {
      this.compacting = false;
      this.hooks.changed();
    }
  }
}

/**
 * What the newest request used: `{ used, limit, share, estimated }`, with
 * the provider's count when it reported one, else the sum of the Host's
 * estimates; `limit` and `share` are null without a known limit. Null
 * without a request or any count.
 */
export function contextUse(request) {
  if (request === null) return null;
  const breakdown = request.breakdown ?? null;
  const estimated = request.reportedInputTokens == null;
  const used = estimated
    ? breakdown === null
      ? null
      : estimate(breakdown)
    : request.reportedInputTokens;
  if (used === null) return null;
  const limit = request.inputLimit ?? request.contextWindow ?? null;
  return { used, limit, share: limit === null ? null : used / limit, estimated };
}

/** The Host's estimate of the whole prepared input: the sum of its parts. */
function estimate(breakdown) {
  return BUCKETS.reduce((sum, [bucket]) => sum + (breakdown[bucket]?.estimatedTokens ?? 0), 0);
}

/** A count of tokens with thousands separated: 200,000. */
function grouped(count) {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A share of the limit as the ring's label: "<1%" for a little, else the rounded percentage. */
function percent(share) {
  if (share > 0 && share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/** The ring's color for a share of the limit. */
function shareColor(share, m) {
  if (share > ALARM_AT) return m.destructive;
  if (share > WARN_AT) return m.warning;
  return m.inkMuted;
}

/** A 16px ring, its track and, clockwise from the top, the arc for `share` of a turn. */
function ring(share, color, track) {
  const center = 8;
  const radius = 6;
  const top = center - radius;
  const circle = PathBuilder.stroke(2)
    .move_to(center, top)
    .arc_to(radius, radius, 0, false, true, center, center + radius)
    .arc_to(radius, radius, 0, false, true, center, top)
    .build();
  const turn = Math.min(1, share);
  let arc = null;
  if (turn >= 1) arc = circle;
  else if (turn > 0) {
    // A sliver stays visible however little is used.
    const angle = Math.max(turn, 0.03) * 2 * Math.PI;
    arc = PathBuilder.stroke(2)
      .move_to(center, top)
      .arc_to(
        radius,
        radius,
        0,
        angle > Math.PI,
        true,
        center + radius * Math.sin(angle),
        center - radius * Math.cos(angle),
      )
      .build();
  }
  const layer = (path, fill) => window.paint_path(path, fill).absolute().top(0).left(0).size(16);
  return div()
    .relative()
    .flex_none()
    .size(16)
    .child(layer(circle, track))
    .when(arc !== null, (el) => el.child(layer(arc, color)));
}

/**
 * The composer's context control, before Send: the ring and the percentage
 * of the limit (the token count alone without a limit), opening the
 * popover. Null while the conversation has no request to show.
 */
export function contextControl(use, cx) {
  const shown = contextUse(use.request);
  if (use.transcript === null || shown === null) return null;
  const m = palette(cx);
  const color = shown.share === null ? m.inkMuted : shareColor(shown.share, m);
  const label =
    shown.share === null
      ? t('contextTokens', { count: grouped(shown.used) })
      : percent(shown.share);
  return Popover.new('context-use')
    .anchor('bottom_right')
    .open(use.open)
    .on_open_change((open) => use.setOpen(open))
    .trigger(
      ghostButton('context-use-button', cx)
        .h(28)
        .px(6)
        .gap(6)
        .rounded(8)
        .when(use.open, (el) => el.bg(m.selected))
        .tooltip(t('contextUseTip'))
        .when(shown.share !== null, (el) => el.child(ring(shown.share, color, m.border)))
        .child(text(label, 'small', color)),
    )
    .content(
      menuSurface(cx)
        .id('context-use-menu')
        .w(320)
        .p(12)
        .gap(10)
        .mb(8)
        .children(
          use.confirm === null ? details(use, shown, cx) : confirmation(use, use.confirm, cx),
        ),
    );
}

/** The popover's details: the model, the use, each part of the input, the counts, and Compact. */
function details(use, shown, cx) {
  const m = palette(cx);
  const request = use.request;
  const breakdown = request.breakdown ?? null;
  const total = breakdown === null ? 0 : estimate(breakdown);
  const usage =
    shown.limit === null
      ? t('contextTokens', { count: grouped(shown.used) })
      : t('contextUsed', {
          used: grouped(shown.used),
          limit: grouped(shown.limit),
          percent: percent(shown.share),
        });
  const counts = breakdown?.counts ?? null;
  const note =
    request.state === 'requested'
      ? t('contextRequested')
      : request.state === 'interrupted'
        ? t('contextInterrupted')
        : null;
  // The report is of the newest request the model was sent; a compaction
  // since then makes the next one smaller, which only that request shows.
  const compacted = use.transcript.rows.some(
    (row) => row.role === 'compaction' && row.position.sourceSequence > request.sequence,
  );
  const enabled = use.canCompact();
  const rows = [
    v_flex()
      .gap(2)
      .child(text(request.modelId, 'label', m.ink).truncate())
      .child(
        text(shown.estimated ? `${usage} · ${t('contextEstimated')}` : usage, 'small', m.inkMuted),
      ),
  ];
  if (breakdown !== null) {
    rows.push(
      v_flex()
        .gap(4)
        .children(
          BUCKETS.map(([bucket, label]) => {
            const tokens = breakdown[bucket]?.estimatedTokens ?? 0;
            const width = total > 0 ? Math.max(0, Math.min(100, (tokens / total) * 100)) : 0;
            return h_flex()
              .gap(8)
              .items_center()
              .child(text(t(label), 'small', m.ink).w(124).flex_none().truncate())
              .child(
                div()
                  .flex_1()
                  .h(4)
                  .rounded(2)
                  .bg(m.wash)
                  .child(
                    div()
                      .h_full()
                      .w(`${width.toFixed(1)}%`)
                      .rounded(2)
                      .bg(m.inkMuted),
                  ),
              )
              .child(text(grouped(tokens), 'small', m.inkMuted).w(56).flex_none().text_right());
          }),
        ),
    );
  }
  if (counts !== null) {
    rows.push(
      text(
        [
          tn(counts.messages, 'contextMessagesOne', 'contextMessagesOther'),
          tn(counts.toolCalls, 'contextToolCallsOne', 'contextToolCallsOther'),
          tn(counts.tools, 'contextToolsOne', 'contextToolsOther'),
        ].join(' · '),
        'small',
        m.inkMuted,
      ),
    );
  }
  if (note !== null) rows.push(text(note, 'small', m.warning));
  if (compacted) rows.push(text(t('contextCompactedSince'), 'small', m.inkMuted));
  rows.push(
    h_flex()
      .justify_end()
      .child(
        controlButton('context-compact', t('compact'), 'outline', !enabled, cx)
          .tooltip(
            enabled
              ? t('compactTip')
              : use.awaitingCompact()
                ? t('compactAwaiting')
                : t('compactUnavailable'),
          )
          .on_click(() => use.askCompact()),
      ),
  );
  return rows;
}

/** The confirmation: what Compact does, the instruction it sends, Cancel and Compact. */
function confirmation(use, confirm, cx) {
  const m = palette(cx);
  const loading = confirm.prompt === null;
  const ready = !loading && use.canCompact();
  return [
    v_flex()
      .gap(2)
      .child(text(t('compactTitle'), 'strong', m.ink))
      .child(text(t('compactHelp'), 'small', m.inkMuted)),
    loading
      ? text(t('compactLoading'), 'small', m.inkMuted)
      : typeset(Textarea.new(use.instruction), 'small')
          .w_full()
          .px(8)
          .py(6)
          .rounded(8)
          .border_1()
          .border_color(m.borderStrong)
          .bg(m.plate)
          .text_color(m.ink),
    h_flex()
      .gap(8)
      .justify_end()
      .child(
        controlButton('compact-cancel', t('cancel'), 'outline', false, cx).on_click(() =>
          use.setOpen(false),
        ),
      )
      .child(
        controlButton('compact-confirm', t('compactConfirm'), 'primary', !ready, cx).on_click(() =>
          use.compact(),
        ),
      ),
  ];
}
