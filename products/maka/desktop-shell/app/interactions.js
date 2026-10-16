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

// What the agent is waiting on in one session: service approvals, permission
// requests, client capabilities and questions, and the card that answers
// them. The watch delivers the pending list, `agent.interaction` reads each
// request once and `agent.respond` answers it, with the answer shapes the TUI
// sends (plugins/agent/agent-screen/component-events.ts, actions.ts
// respondInteraction and submitQuestion). A form is left to the TUI for now.

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { query, operation, log } from './host.js';
import { palette, text, icon, controlButton } from './theme.js';

const SCOPES = [
  ['once', 'Allow once'],
  ['turn', 'Allow for this turn'],
  ['session', 'Allow for this session'],
];

export class Interactions {
  /**
   * @param {string} sessionId
   * @param {{ changed: () => void, report: (message: string) => void }} hooks
   */
  constructor(sessionId, hooks) {
    this.sessionId = sessionId;
    this.hooks = hooks;
    /** The pending entries as the Host last listed them: { requestId, kind, toolUseId }. */
    this.entries = [];
    /** requestId -> the request's record, or null while it is being read. */
    this.records = new Map();
    /** requestId -> the answers chosen so far for a question with several parts. */
    this.drafts = new Map();
    /** requestId -> why reading it failed; the card offers to read it again. */
    this.failures = new Map();
    /** The request whose answer is in flight, if any. */
    this.responding = null;
    this.revision = -1;
    this.closed = false;
  }

  /** Reads the pending list; the watch reports only what changes after it opened. */
  async refresh() {
    try {
      this.accept(await query('agent', 'pendingInteractions', { sessionId: this.sessionId }));
    } catch (error) {
      if (!this.closed) this.hooks.report(`Pending requests: ${error.message}`);
    }
  }

  /** Applies a pending list from the watch or `pendingInteractions`; an older revision is ignored. */
  accept(pending) {
    if (this.closed || pending.revision < this.revision) return;
    this.revision = pending.revision;
    this.entries = pending.entries;
    const open = new Set(pending.entries.map((entry) => entry.requestId));
    for (const id of [...this.records.keys()]) if (!open.has(id)) this.records.delete(id);
    for (const id of [...this.drafts.keys()]) if (!open.has(id)) this.drafts.delete(id);
    for (const id of [...this.failures.keys()]) if (!open.has(id)) this.failures.delete(id);
    for (const entry of pending.entries) {
      if (!this.records.has(entry.requestId)) this.read(entry.requestId);
    }
    this.hooks.changed();
  }

  async read(requestId) {
    this.records.set(requestId, null);
    this.failures.delete(requestId);
    try {
      const record = await query('agent', 'interaction', { sessionId: this.sessionId, requestId });
      if (this.closed || !this.entries.some((entry) => entry.requestId === requestId)) return;
      this.records.set(requestId, record);
      this.hooks.changed();
    } catch (error) {
      this.records.delete(requestId);
      if (this.closed) return;
      // The pending list may not change while the agent waits, so nothing
      // else would read it again.
      this.failures.set(requestId, error.message);
      this.hooks.report(`Request ${requestId}: ${error.message}`);
      this.hooks.changed();
    }
  }

  /** Reads again the requests whose read failed. */
  retry() {
    for (const id of [...this.failures.keys()]) this.read(id);
    this.hooks.changed();
  }

  /** The first request that has been read and not answered. */
  current() {
    for (const entry of this.entries) {
      const record = this.records.get(entry.requestId);
      if (record && !record.outcome) return record;
    }
    return null;
  }

  /**
   * Answers one request. Never retried: a lost reply must not become a
   * second answer, and the pending list says what happened.
   */
  async respond(record, answer) {
    if (this.responding !== null || this.closed) return;
    this.responding = record.requestId;
    this.hooks.changed();
    try {
      const result = await operation('agent', 'respond', {
        sessionId: this.sessionId,
        requestId: record.requestId,
        answer,
      });
      log(`interactions: ${record.request.kind} ${record.requestId} ${result.kind}`);
      if (result.kind === 'rejected') {
        throw new Error(`the Host rejected the answer (${result.reason})`);
      }
      // The record holds the canonical outcome, which may be another client's answer.
      this.records.set(record.requestId, result.record);
    } catch (error) {
      if (!this.closed) {
        this.hooks.report(`Answer: ${error.message}`);
        this.refresh();
      }
    } finally {
      this.responding = null;
      this.hooks.changed();
    }
  }

  /** Records one part of a question; a single question is answered at once. */
  choose(record, index, answer) {
    const count = record.request.questions.length;
    const draft = this.drafts.get(record.requestId) ?? new Array(count).fill(undefined);
    draft[index] = answer;
    this.drafts.set(record.requestId, draft);
    if (count === 1) this.respond(record, { kind: 'question', answers: draft });
    else this.hooks.changed();
  }

  close() {
    this.closed = true;
  }
}

/**
 * The card for the first pending request, or null when there is none. It sits
 * above the composer in the reading column.
 * @param {Interactions} interactions
 */
export function interactionCard(interactions, cx) {
  const record = interactions.current();
  if (record === null) return interactions.failures.size > 0 ? failureCard(interactions, cx) : null;
  const m = palette(cx);
  const busy = interactions.responding !== null;
  const waiting = interactions.entries.length - 1;
  const request = record.request;
  const id = record.requestId;
  const respond = (answer) => interactions.respond(record, answer);

  let title;
  /** @type {any[]} */
  let body = [];
  /** @type {any[]} */
  let actions = [];
  switch (request.kind) {
    case 'service_approval':
      title = 'Allow this service call?';
      body = [detail(`${request.toolName} calls ${request.service}.${request.method}`, cx)];
      actions = decisions(id, busy, cx, (decision) =>
        respond({ kind: 'service_approval', decision }),
      );
      break;
    case 'client_capability': {
      const target = request.target;
      title = 'Allow this capability?';
      body = [detail(`${target.toolName} uses ${capability(target)}`, cx)];
      actions = decisions(id, busy, cx, (decision) =>
        respond({ kind: 'client_capability', decision }),
      );
      break;
    }
    case 'permissions': {
      const permissions = request.request.permissions;
      title = 'Allow more access?';
      body = [detail(request.request.reason, cx)];
      if (request.request.command) {
        body.push(command(request.request.command, cx));
      }
      actions = [
        ...SCOPES.map(([scope, label]) =>
          controlButton(`${id}-${scope}`, label, scope === 'once' ? 'primary' : 'outline', busy, cx)
            .on_click(() =>
              respond({ kind: 'permissions', decision: { decision: 'allow', scope, permissions } }),
            ),
        ),
        controlButton(`${id}-deny`, 'Deny', 'outline', busy, cx).on_click(() =>
          respond({ kind: 'permissions', decision: { decision: 'deny' } }),
        ),
      ];
      break;
    }
    case 'question': {
      const draft = interactions.drafts.get(id) ?? [];
      title = request.questions.length === 1 ? 'The agent asks' : 'The agent asks a few things';
      body = request.questions.map((question, index) =>
        questionPart(id, question, index, draft[index], busy, cx, (answer) =>
          interactions.choose(record, index, answer),
        ),
      );
      if (request.questions.length > 1) {
        const complete = request.questions.every((_, index) => draft[index] !== undefined);
        actions = [
          controlButton(`${id}-submit`, 'Submit', 'primary', busy || !complete, cx).on_click(() =>
            respond({ kind: 'question', answers: draft }),
          ),
        ];
      }
      break;
    }
    default:
      title = 'The agent needs a form filled in';
      body = [
        detail(request.message ?? '', cx),
        detail('The desktop cannot fill in forms yet; answer it in the terminal app (maka).', cx),
      ];
  }

  return column(
    frame(cx)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(icon('status-waiting', 16, m.warning))
          .child(text(title, 'strong', m.ink).flex_1().min_w_0())
          .when(waiting > 0, (el) =>
            el.child(text(`${waiting} more waiting`, 'small', m.inkMuted).flex_none()),
          ),
      )
      .children(body)
      .when(actions.length > 0, (el) =>
        el.child(
          h_flex()
            .flex_wrap()
            .gap(8)
            .items_center()
            .children(actions)
            .child(div().flex_1())
            .child(text(busy ? 'Answering…' : 'Waiting for your answer', 'small', m.inkMuted)),
        ),
      ),
  );
}

function failureCard(interactions, cx) {
  const m = palette(cx);
  const [reason] = interactions.failures.values();
  return column(
    frame(cx)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(icon('status-failed', 16, m.destructive))
          .child(
            text('The agent is waiting, but its request could not be read', 'strong', m.ink)
              .flex_1()
              .min_w_0(),
          ),
      )
      .child(detail(reason, cx))
      .child(
        h_flex().child(
          controlButton('interaction-retry', 'Try again', 'primary', false, cx).on_click(() =>
            interactions.retry(),
          ),
        ),
      ),
  );
}

function decisions(id, busy, cx, decide) {
  return [
    controlButton(`${id}-allow`, 'Allow', 'primary', busy, cx).on_click(() => decide('allow')),
    controlButton(`${id}-deny`, 'Deny', 'outline', busy, cx).on_click(() => decide('deny')),
  ];
}

/** The reading column the card sits in, above the composer. */
function column(card) {
  return h_flex()
    .flex_none()
    .w_full()
    .px(24)
    .pt(8)
    .justify_center()
    .child(card);
}

/** The card's box. */
function frame(cx) {
  const m = palette(cx);
  return v_flex()
    .w_full()
    .max_w(720)
    .p(12)
    .gap(8)
    .rounded(12)
    .border_1()
    .border_color(m.border)
    .bg(m.plate);
}

function capability(target) {
  const scope = target.scope;
  if (scope.kind === 'browser_origin') return `${target.capability} on ${scope.origin}`;
  if (scope.kind === 'mcp_tool') return `${scope.serverId}.${scope.toolName}`;
  return target.capability;
}

function detail(content, cx) {
  return text(content, 'body', palette(cx).ink);
}

function command(run, cx) {
  const m = palette(cx);
  return v_flex()
    .px(12)
    .py(10)
    .rounded(10)
    .bg(m.code)
    .text_size(14)
    .line_height('20px')
    .font_family('Menlo')
    .text_color(m.ink)
    .child(div().child(`$ ${run.command}`))
    .child(
      div().text_size(12).text_color(m.inkMuted).child(`in ${run.cwd}`),
    );
}

function questionPart(id, question, index, chosen, busy, cx, choose) {
  const m = palette(cx);
  const option = (key, label, picked) =>
    controlButton(key, label, 'outline', busy, cx)
      .h(28)
      .px(10)
      .when(picked, (el) => el.bg(m.selected).border_color(m.accent));
  return v_flex()
    .gap(6)
    .child(detail(question.question, cx))
    .child(
      h_flex()
        .flex_wrap()
        .gap(6)
        .children(
          question.options.map((entry, choice) =>
            option(`${id}-${index}-${choice}`, entry.label, chosen === entry.label)
              .when(entry.description !== undefined, (el) => el.tooltip(entry.description))
              .on_click(() => choose(entry.label)),
          ),
        )
        .child(option(`${id}-${index}-skip`, 'Skip', chosen === null).on_click(() => choose(null))),
    );
}
