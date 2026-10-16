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
// respondInteraction and submitQuestion, and plugins/agent/form-editor).

import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState } from 'gpui-base';
import { query, operation, log } from './host.js';
import { palette, text, icon, controlButton, textField } from './theme.js';
import { t, tn, onLanguageChange } from './locale.js';

/** The scopes a permission can be allowed for, with the message that labels each. */
const SCOPES = [
  ['once', 'allowOnce'],
  ['turn', 'allowForTurn'],
  ['session', 'allowForSession'],
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
    /** requestId -> the form being filled in, for a form request. */
    this.forms = new Map();
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
      if (!this.closed) this.hooks.report(t('pendingRequestsFailed', { value: error.message }));
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
    for (const [id, form] of [...this.forms]) {
      if (open.has(id)) continue;
      form.release();
      this.forms.delete(id);
    }
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
      this.adopt(record);
    } catch (error) {
      this.records.delete(requestId);
      if (this.closed) return;
      // The pending list may not change while the agent waits, so nothing
      // else would read it again.
      this.failures.set(requestId, error.message);
      this.hooks.report(t('requestFailed', { id: requestId, value: error.message }));
      this.hooks.changed();
    }
  }

  /** Keeps a request's record, with a draft to fill in when it is an open form. */
  adopt(record) {
    const id = record.requestId;
    this.records.set(id, record);
    if (record.request.kind === 'form' && !record.outcome && !this.forms.has(id)) {
      this.forms.set(id, new FormDraft(record.request.fields, () => this.hooks.changed()));
    }
    this.hooks.changed();
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
        throw new Error(t('hostRejectedAnswer', { value: result.reason }));
      }
      // The record holds the canonical outcome, which may be another client's answer.
      this.records.set(record.requestId, result.record);
    } catch (error) {
      if (!this.closed) {
        this.hooks.report(t('answerFailed', { value: error.message }));
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

  /** Sends a filled-in form, or marks the first field that cannot be sent. */
  submitForm(record) {
    const form = this.forms.get(record.requestId);
    const values = form?.values();
    if (values) this.respond(record, { kind: 'form', action: 'accept', values });
    else this.hooks.changed();
  }

  close() {
    this.closed = true;
    for (const form of this.forms.values()) form.release();
    this.forms.clear();
  }
}

/** The fields typed as text: a string, or a number read from text. */
const TEXTUAL = new Set(['string', 'number', 'integer']);

/** What a text field shows while it is empty, by format: an example, the same in every language. */
const PLACEHOLDERS = {
  email: 'name@example.com',
  uri: 'https://',
  date: 'YYYY-MM-DD',
  'date-time': 'YYYY-MM-DDThh:mm:ssZ',
};
/** What a number field shows while it is empty, by kind: the message that says what to enter. */
const PLACEHOLDER_MESSAGES = {
  number: 'placeholderNumber',
  integer: 'placeholderWholeNumber',
};

/** The placeholder of a field typed as text, in the current language. */
function placeholder(field) {
  const name = field.format ?? field.kind;
  if (Object.hasOwn(PLACEHOLDERS, name)) return PLACEHOLDERS[name];
  return Object.hasOwn(PLACEHOLDER_MESSAGES, name) ? t(PLACEHOLDER_MESSAGES[name]) : '';
}

/**
 * The answers to one form while they are filled in: a text state for each
 * field typed as text, and the chosen value (or values) for the rest. A field
 * starts from the request's default. An optional field is sent only when it
 * has a value; a required one must have a valid one.
 */
class FormDraft {
  constructor(fields, changed) {
    this.fields = fields;
    this.changed = changed;
    /** The field that stopped the last submission and why; index -1 is the whole form. */
    this.problem = null;
    /** Stop the text states' placeholders following the language; `release` calls them. */
    this.unsubscribe = [];
    this.drafts = fields.map((field, index) => {
      if (!TEXTUAL.has(field.kind)) {
        return field.default ?? (field.kind === 'multi_select' ? [] : null);
      }
      const state = InputState.new({
        placeholder: placeholder(field),
        value: field.default == null ? '' : String(field.default),
      });
      state.on('change', () => this.edited(index));
      this.unsubscribe.push(onLanguageChange(() => state.set_placeholder(placeholder(field))));
      return state;
    });
  }

  /** Text state for a field typed as text. */
  state(index) {
    return this.drafts[index];
  }

  /** The value chosen for a boolean or select field. */
  chosen(index) {
    return this.drafts[index];
  }

  /**
   * Chooses a value for a boolean or single select. Choosing the chosen value
   * of an optional field clears it, so it can be left out again.
   */
  choose(index, value) {
    const field = this.fields[index];
    this.drafts[index] = !field.required && this.drafts[index] === value ? null : value;
    this.edited(index);
  }

  /** Adds or removes one value of a multi select, keeping the options' order. */
  toggle(index, value) {
    const field = this.fields[index];
    const current = new Set(this.drafts[index]);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    this.drafts[index] = field.options.map((option) => option.value).filter((v) => current.has(v));
    this.edited(index);
  }

  edited(index) {
    if (this.problem !== null && (this.problem.index === index || this.problem.index === -1)) {
      this.problem = null;
    }
    this.changed();
  }

  /**
   * The values to send, or null after recording the first field that cannot
   * be sent. The checks are the Host's (facts/src/capability/form_validation.rs)
   * and the form editor's size limits.
   */
  values() {
    // Without a prototype, and defined rather than assigned, so that a field
    // named `__proto__` is an answer like any other (as the TUI's form editor
    // builds it).
    const values = Object.create(null);
    for (const [index, field] of this.fields.entries()) {
      const draft = this.drafts[index];
      const raw = TEXTUAL.has(field.kind) ? draft.value() : draft;
      const empty =
        raw === null || raw === '' || (field.kind === 'multi_select' && raw.length === 0);
      if (empty && !field.required) continue;
      const parsed = TEXTUAL.has(field.kind) && field.kind !== 'string' ? number(raw) : raw;
      // A required field is missing only with no choice made: an empty text
      // or no options picked can be an answer, which the field's own limits
      // judge, as the Host does.
      const problem = raw === null ? t('required') : fieldProblem(field, parsed);
      if (problem !== null) {
        this.problem = { index, message: problem };
        return null;
      }
      Object.defineProperty(values, field.name, { value: parsed, enumerable: true, configurable: true, writable: true });
    }
    const answer = { kind: 'form_answer', action: 'accept', values, committedAt: Number.MAX_SAFE_INTEGER };
    if (utf8Length(JSON.stringify(answer)) > 8192) {
      this.problem = { index: -1, message: t('answersTooLong') };
      return null;
    }
    this.problem = null;
    return values;
  }

  /**
   * Releases the text states, once the request is answered or gone or its
   * session closed; their placeholders stop following the language first.
   */
  release() {
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const [index, field] of this.fields.entries()) {
      if (TEXTUAL.has(field.kind)) this.drafts[index].release();
    }
  }
}

/** A number typed as text, or null when the text is not one (the form editor's pattern). */
function number(text) {
  const trimmed = text.trim();
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : null;
}

function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Why a field's value cannot be sent, or null when it can. */
function fieldProblem(field, value) {
  switch (field.kind) {
    case 'string': {
      const length = [...value].length;
      if (length < (field.minLength ?? 0)) {
        return tn(field.minLength, 'useAtLeastCharactersOne', 'useAtLeastCharactersOther');
      }
      if (length > (field.maxLength ?? 2048) || utf8Length(value) > 2048) {
        return tn(field.maxLength ?? 2048, 'useAtMostCharactersOne', 'useAtMostCharactersOther');
      }
      return formatProblem(value, field.format);
    }
    case 'number':
    case 'integer':
      if (value === null || !Number.isFinite(value)) {
        return field.kind === 'integer' ? t('enterWholeNumber') : t('enterNumber');
      }
      if (field.kind === 'integer' && !Number.isSafeInteger(value)) return t('enterWholeNumber');
      if (value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)) {
        return range(field, true);
      }
      return null;
    case 'multi_select': {
      const fewest = field.minItems ?? 0;
      const most = field.maxItems ?? field.options.length;
      if (value.length < fewest || value.length > most) return chooseCount(fewest, most);
      return null;
    }
    default:
      return null;
  }
}

function formatProblem(value, format) {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : t('enterEmail');
    case 'uri':
      return uri(value) ? null : t('enterFullAddress');
    case 'date':
      return calendar(value, false) ? null : t('enterDate');
    case 'date-time':
      return calendar(value, true) ? null : t('enterDateTime');
    default:
      return null;
  }
}

/**
 * Whether `value` reads as an absolute URL, near enough to the Host's check
 * (`url::Url::parse`): a scheme, then for the web schemes a host, with an
 * IPv6 address bracketed and a port up to 65535. Spaces around it are
 * ignored, as the parser ignores them. Anything this lets through that the
 * parser refuses comes back from the Host as a refused answer.
 */
function uri(value) {
  const trimmed = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(trimmed);
  if (scheme === null) return false;
  if (!/^(?:https?|wss?|ftp)$/i.test(scheme[1])) return true;
  const web = /^\/\/(?:[^\/?#@]*@)?(\[[0-9a-fA-F:.]+\]|[^\s\/?#:@\[\]]+)(?::(\d*))?(?:[\/?#].*)?$/s.exec(scheme[2]);
  return web !== null && (web[2] === undefined || web[2] === '' || Number(web[2]) <= 65535);
}

/** Whether `value` is a real calendar date (and time), as the Host checks it. */
function calendar(value, time) {
  const match = time
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const n = (index) => Number(match[index] ?? 0);
  const [year, month, day] = [n(1), n(2), n(3)];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    (!time || (n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(7) <= 23 && n(8) <= 59))
  );
}

/**
 * The messages for a number field's limits, by kind and by which ends are
 * set: the hint ("A number from 1 to 10") and the problem ("Enter a whole
 * number of at least 1").
 */
const RANGES = {
  number: {
    both: ['numberFromTo', 'enterNumberFromTo'],
    low: ['numberAtLeast', 'enterNumberAtLeast'],
    high: ['numberAtMost', 'enterNumberAtMost'],
  },
  integer: {
    both: ['wholeNumberFromTo', 'enterWholeNumberFromTo'],
    low: ['wholeNumberAtLeast', 'enterWholeNumberAtLeast'],
    high: ['wholeNumberAtMost', 'enterWholeNumberAtMost'],
  },
};

/** A number field's limits as its hint, or with `enter` as what to enter. */
function range(field, enter) {
  const low = field.minimum;
  const high = field.maximum;
  const ends = low != null && high != null ? 'both' : low != null ? 'low' : 'high';
  const [hint, problem] = RANGES[field.kind === 'integer' ? 'integer' : 'number'][ends];
  return t(enter ? problem : hint, { low, high });
}

/** "Choose 1 to 3 options", "Choose at most 2 options", "Choose 1 option", … */
function chooseCount(fewest, most) {
  if (fewest === most) return tn(most, 'chooseOptionsOne', 'chooseOptionsOther');
  if (fewest === 0) return tn(most, 'chooseAtMostOptionsOne', 'chooseAtMostOptionsOther');
  return tn(most, 'chooseOptionsRangeOne', 'chooseOptionsRangeOther', { low: fewest });
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
      title = t('allowServiceCall');
      body = [
        detail(
          t('serviceCallDetail', {
            tool: request.toolName,
            call: `${request.service}.${request.method}`,
          }),
          cx,
        ),
      ];
      actions = decisions(id, busy, cx, (decision) =>
        respond({ kind: 'service_approval', decision }),
      );
      break;
    case 'client_capability': {
      const target = request.target;
      title = t('allowCapability');
      body = [
        detail(
          t('capabilityDetail', { tool: target.toolName, capability: capability(target) }),
          cx,
        ),
      ];
      actions = decisions(id, busy, cx, (decision) =>
        respond({ kind: 'client_capability', decision }),
      );
      break;
    }
    case 'permissions': {
      const permissions = request.request.permissions;
      title = t('allowMoreAccess');
      body = [detail(request.request.reason, cx)];
      if (request.request.command) {
        body.push(command(request.request.command, cx));
      }
      actions = [
        ...SCOPES.map(([scope, label]) =>
          controlButton(
            `${id}-${scope}`,
            t(label),
            scope === 'once' ? 'primary' : 'outline',
            busy,
            cx,
          ).on_click(() =>
            respond({ kind: 'permissions', decision: { decision: 'allow', scope, permissions } }),
          ),
        ),
        controlButton(`${id}-deny`, t('deny'), 'outline', busy, cx).on_click(() =>
          respond({ kind: 'permissions', decision: { decision: 'deny' } }),
        ),
      ];
      break;
    }
    case 'question': {
      const draft = interactions.drafts.get(id) ?? [];
      title = request.questions.length === 1 ? t('agentAsks') : t('agentAsksSeveral');
      body = request.questions.map((question, index) =>
        questionPart(id, question, index, draft[index], busy, cx, (answer) =>
          interactions.choose(record, index, answer),
        ),
      );
      if (request.questions.length > 1) {
        const complete = request.questions.every((_, index) => draft[index] !== undefined);
        actions = [
          controlButton(`${id}-submit`, t('submit'), 'primary', busy || !complete, cx).on_click(
            () => respond({ kind: 'question', answers: draft }),
          ),
        ];
      }
      break;
    }
    case 'form': {
      const form = interactions.forms.get(id);
      title = t('agentNeedsDetails');
      body = [
        requester(request.requester, cx),
        detail(request.message, cx),
        form === undefined ? null : formFields(id, form, busy, cx),
      ].filter((part) => part !== null);
      // A field's problem shows on its row, which may be scrolled away, so it
      // is named here too.
      const problem = form?.problem ?? null;
      if (problem !== null) {
        const label = problem.index >= 0 ? request.fields[problem.index].label : null;
        const message =
          label !== null ? t('fieldProblem', { label, problem: problem.message }) : problem.message;
        body.push(text(message, 'small', m.destructive));
      }
      actions = [
        controlButton(
          `${id}-submit`,
          t('submit'),
          'primary',
          busy || form === undefined,
          cx,
        ).on_click(() => interactions.submitForm(record)),
        controlButton(`${id}-decline`, t('decline'), 'outline', busy, cx).on_click(() =>
          respond({ kind: 'form', action: 'decline' }),
        ),
        controlButton(`${id}-cancel`, t('cancelRequest'), 'outline', busy, cx).on_click(() =>
          respond({ kind: 'form', action: 'cancel' }),
        ),
      ];
      break;
    }
    default:
      title = t('agentWaitingUnknown');
      body = [detail(t('answerInTerminal', { kind: request.kind }), cx)];
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
            el.child(text(t('moreWaiting', { count: waiting }), 'small', m.inkMuted).flex_none()),
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
            .child(text(busy ? t('answering') : t('waitingForAnswer'), 'small', m.inkMuted)),
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
            text(t('requestUnreadable'), 'strong', m.ink)
              .flex_1()
              .min_w_0(),
          ),
      )
      .child(detail(reason, cx))
      .child(
        h_flex().child(
          controlButton('interaction-retry', t('tryAgain'), 'primary', false, cx).on_click(() =>
            interactions.retry(),
          ),
        ),
      ),
  );
}

function decisions(id, busy, cx, decide) {
  return [
    controlButton(`${id}-allow`, t('allow'), 'primary', busy, cx).on_click(() => decide('allow')),
    controlButton(`${id}-deny`, t('deny'), 'outline', busy, cx).on_click(() => decide('deny')),
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
  if (scope.kind === 'browser_origin') {
    return t('capabilityOnOrigin', { capability: target.capability, origin: scope.origin });
  }
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
      div().text_size(12).text_color(m.inkMuted).child(t('commandIn', { path: run.cwd })),
    );
}

/** A 28px choice button, drawn as picked with the accent ring. */
function optionButton(key, label, picked, busy, cx) {
  const m = palette(cx);
  return controlButton(key, label, 'outline', busy, cx)
    .h(28)
    .px(10)
    .when(picked, (el) => el.bg(m.selected).border_color(m.accent));
}

/** Who asks for the form: the requester the Host names, and where it comes from. */
function requester(who, cx) {
  const m = palette(cx);
  return h_flex()
    .gap(6)
    .items_center()
    .child(text(t('fromRequester', { name: who.name }), 'small', m.inkMuted).flex_none())
    .when(who.source != null, (el) =>
      el.child(text(who.source, 'small', m.inkDisabled).min_w_0().truncate()),
    );
}

/**
 * A form's fields, one row each as settings draws them: the label and what to
 * know about it on the left, the control on the right. The rows scroll when a
 * long form would push the composer off the plate.
 * @param {FormDraft} form
 */
function formFields(id, form, busy, cx) {
  return v_flex()
    .id(`${id}-fields`)
    .max_h(320)
    .overflow_y_scrollbar()
    .children(form.fields.map((field, index) => formField(id, form, field, index, busy, cx)));
}

function formField(id, form, field, index, busy, cx) {
  const m = palette(cx);
  const key = `${id}-field-${index}`;
  let control;
  switch (field.kind) {
    case 'string':
    case 'number':
    case 'integer':
      control = div().w(280).child(textField(form.state(index), cx));
      break;
    case 'boolean':
      control = choices([
        optionButton(`${key}-yes`, t('yes'), form.chosen(index) === true, busy, cx).on_click(() =>
          form.choose(index, true),
        ),
        optionButton(`${key}-no`, t('no'), form.chosen(index) === false, busy, cx).on_click(() =>
          form.choose(index, false),
        ),
      ]);
      break;
    case 'single_select':
      control = choices(
        field.options.map((entry, choice) =>
          optionButton(`${key}-${choice}`, entry.label, form.chosen(index) === entry.value, busy, cx)
            .on_click(() => form.choose(index, entry.value)),
        ),
      );
      break;
    case 'multi_select':
      control = choices(
        field.options.map((entry, choice) =>
          optionButton(`${key}-${choice}`, entry.label, form.chosen(index).includes(entry.value), busy, cx)
            .on_click(() => form.toggle(index, entry.value)),
        ),
      );
      break;
    default:
      control = text(t('fieldKindUnsupported', { kind: field.kind }), 'small', m.inkMuted);
  }
  const problem = form.problem?.index === index ? form.problem.message : null;
  const note = problem ?? ([field.description, fieldHint(field)].filter(Boolean).join(' · ') || null);
  return h_flex()
    .w_full()
    .py(8)
    .gap(16)
    .items_center()
    .when(index > 0, (el) => el.border_t_1().border_color(m.borderSoft))
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(text(field.label, 'label', m.ink).min_w_0().truncate())
            .when(field.required, (el) =>
              el.child(text(t('required'), 'small', m.inkMuted).flex_none()),
            ),
        )
        .when(note !== null, (el) =>
          el.child(text(note, 'small', problem !== null ? m.destructive : m.inkMuted)),
        ),
    )
    .child(h_flex().flex_none().max_w(360).justify_end().child(control));
}

function choices(buttons) {
  return h_flex().flex_wrap().justify_end().gap(6).children(buttons);
}

/** The limits a field states, in words, or null when it has none. */
function fieldHint(field) {
  switch (field.kind) {
    case 'string': {
      const low = field.minLength ?? null;
      const high = field.maxLength ?? null;
      if (low !== null && high !== null) {
        return tn(high, 'charactersRangeOne', 'charactersRangeOther', { low });
      }
      if (low !== null) return tn(low, 'atLeastCharactersOne', 'atLeastCharactersOther');
      if (high !== null) return tn(high, 'atMostCharactersOne', 'atMostCharactersOther');
      return null;
    }
    case 'number':
    case 'integer':
      if (field.minimum == null && field.maximum == null) return null;
      return range(field, false);
    case 'multi_select': {
      const fewest = field.minItems ?? 0;
      const most = field.maxItems ?? field.options.length;
      if (fewest === 0 && most === field.options.length) return t('chooseAny');
      return chooseCount(fewest, most);
    }
    default:
      return null;
  }
}

function questionPart(id, question, index, chosen, busy, cx, choose) {
  const option = (key, label, picked) => optionButton(key, label, picked, busy, cx);
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
        .child(
          option(`${id}-${index}-skip`, t('skip'), chosen === null).on_click(() => choose(null)),
        ),
    );
}
