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
import { button } from './composer.js';

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
    for (const entry of pending.entries) {
      if (!this.records.has(entry.requestId)) this.read(entry.requestId);
    }
    this.hooks.changed();
  }

  async read(requestId) {
    this.records.set(requestId, null);
    try {
      const record = await query('agent', 'interaction', { sessionId: this.sessionId, requestId });
      if (this.closed || !this.entries.some((entry) => entry.requestId === requestId)) return;
      this.records.set(requestId, record);
      this.hooks.changed();
    } catch (error) {
      this.records.delete(requestId);
      if (!this.closed) this.hooks.report(`Request ${requestId}: ${error.message}`);
    }
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
 * The card for the first pending request, or null when there is none.
 * @param {Interactions} interactions
 */
export function interactionCard(interactions, cx) {
  const record = interactions.current();
  if (record === null) return null;
  const theme = cx.theme();
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
        button(`${id}-deny`, 'Deny', false, busy, cx).on_click(() =>
          respond({ kind: 'permissions', decision: { decision: 'deny' } }),
        ),
        ...SCOPES.map(([scope, label]) =>
          button(`${id}-${scope}`, label, scope === 'once', busy, cx).on_click(() =>
            respond({ kind: 'permissions', decision: { decision: 'allow', scope, permissions } }),
          ),
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
          button(`${id}-submit`, 'Submit', true, busy || !complete, cx).on_click(() =>
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

  return v_flex()
    .flex_none()
    .mx(theme.spacing.xl)
    .mt(theme.spacing.md)
    .p(theme.spacing.md)
    .gap(theme.spacing.sm)
    .rounded(theme.radius.lg)
    .border_1()
    .border_color(theme.colors.primary)
    .bg(theme.colors.surface)
    .child(
      h_flex()
        .gap(theme.spacing.sm)
        .items_center()
        .child(div().flex_1().min_w_0().font_weight(600).child(title))
        .when(waiting > 0, (el) =>
          el.child(
            div()
              .text_xs()
              .text_color(theme.colors.muted_foreground)
              .child(`${waiting} more waiting`),
          ),
        ),
    )
    .children(body)
    .when(actions.length > 0, (el) =>
      el.child(h_flex().gap(theme.spacing.sm).justify_end().children(actions)),
    );
}

function decisions(id, busy, cx, decide) {
  return [
    button(`${id}-deny`, 'Deny', false, busy, cx).on_click(() => decide('deny')),
    button(`${id}-allow`, 'Allow', true, busy, cx).on_click(() => decide('allow')),
  ];
}

function capability(target) {
  const scope = target.scope;
  if (scope.kind === 'browser_origin') return `${target.capability} on ${scope.origin}`;
  if (scope.kind === 'mcp_tool') return `${scope.serverId}.${scope.toolName}`;
  return target.capability;
}

function detail(text, cx) {
  return div().text_sm().text_color(cx.theme().colors.foreground).child(text);
}

function command(run, cx) {
  const theme = cx.theme();
  return v_flex()
    .px(theme.spacing.md)
    .py(theme.spacing.sm)
    .rounded(theme.radius.md)
    .bg(theme.colors.muted)
    .text_sm()
    .font_family(theme.typography.mono)
    .child(div().child(`$ ${run.command}`))
    .child(div().text_xs().text_color(theme.colors.muted_foreground).child(`in ${run.cwd}`));
}

function questionPart(id, question, index, chosen, busy, cx, choose) {
  const theme = cx.theme();
  return v_flex()
    .gap(theme.spacing.xs)
    .child(detail(question.question, cx))
    .child(
      h_flex()
        .flex_wrap()
        .gap(theme.spacing.sm)
        .children(
          question.options.map((option, choice) =>
            button(`${id}-${index}-${choice}`, option.label, chosen === option.label, busy, cx)
              .when(option.description !== undefined, (el) => el.tooltip(option.description))
              .on_click(() => choose(option.label)),
          ),
        )
        .child(
          button(`${id}-${index}-skip`, 'Skip', chosen === null, busy, cx).on_click(() =>
            choose(null),
          ),
        ),
    );
}
