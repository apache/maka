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

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class NotebookValidationError extends Error {}

const requireThat = (ok: unknown, message: string) => {
  if (!ok) throw new NotebookValidationError(message);
};
const nonempty = (x: any) => typeof x === 'string' && x.trim().length > 0;
const strings = (x: any) => Array.isArray(x) && x.every(nonempty);
const iso = (x: any) =>
  typeof x === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(x) && Number.isFinite(Date.parse(x));
const fingerprint = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const overlaps = (a: string[], b: string[]) => a.some((x) => b.includes(x));

// Append-only shared context. The Host owns user feedback and delivery receipts;
// the model chooses which observations and recommendations have value.
export class Notebook {
  db: DatabaseSync;
  clock: () => string;
  delivering: boolean;
  constructor(path: string, clock = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.delivering = false;
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  events(kind?: string): any[] {
    return (
      kind
        ? this.db.prepare('SELECT * FROM events WHERE kind=? ORDER BY seq').all(kind)
        : this.db.prepare('SELECT * FROM events ORDER BY seq').all()
    ).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
  }
  event(id: string): any {
    const r = this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
    return r && { ...r, payload: JSON.parse(String(r.payload)) };
  }
  put(id: string, kind: string, payload: any, at = this.clock()) {
    requireThat(nonempty(id) && iso(at), 'Event ID and recorded time required');
    const old = this.event(id);
    if (old) {
      requireThat(
        old.kind === kind && fingerprint(old.payload) === fingerprint(payload),
        'Operation ID content conflict',
      );
      return old.seq;
    }
    return Number(
      this.db
        .prepare('INSERT INTO events(id,kind,at,payload) VALUES(?,?,?,?)')
        .run(id, kind, at, JSON.stringify(payload)).lastInsertRowid,
    );
  }
  feedback() {
    // Legacy conversation imports had no delivery relationship. Retain their events
    // for audit, but do not treat ordinary chats or their inferred rules as feedback.
    return this.events('feedback').filter(
      (e) => this.event(e.payload.replyTo ?? '')?.kind === 'delivery',
    );
  }
  feedbackResolutions() {
    const valid = new Set(this.feedback().map((e) => e.id));
    return this.events('feedback-resolution').filter((e) => valid.has(e.payload.feedbackId));
  }
  revision() {
    return this.feedback().at(-1)?.seq ?? 0;
  }
  pendingFeedback() {
    const settled = new Set(this.events('feedback-resolution').map((e) => e.payload.feedbackId));
    return this.feedback().filter((e) => !settled.has(e.id));
  }
  topics() {
    const topics = new Map<string, any>();
    for (const e of this.events('note')) {
      const n = e.payload;
      const topic = topics.get(n.topicId) ?? { id: n.topicId, title: n.title, tags: [], notes: [] };
      topic.tags = [...new Set([...topic.tags, ...(n.tags ?? [])])];
      topic.notes.push({ ...n, recordedAt: e.at });
      topics.set(n.topicId, topic);
    }
    return topics;
  }
  state(topicId: string, now = this.clock()) {
    const topic = this.topics().get(topicId);
    requireThat(topic, 'Unknown topic');
    let current: any = { status: 'open', reason: null, feedbackId: null };
    for (const e of this.feedbackResolutions().sort(
      (a, b) => this.event(a.payload.feedbackId).seq - this.event(b.payload.feedbackId).seq,
    ))
      for (const [ruleIndex, rule] of e.payload.rules.entries()) {
        if (!rule.topicIds.includes(topicId) && !overlaps(rule.tags, topic.tags)) continue;
        current = { ...rule, feedbackId: e.payload.feedbackId, ruleIndex };
      }
    if (current.feedbackId && ['closed', 'deferred'].includes(current.status)) {
      const governing = this.event(current.feedbackId)!.seq;
      // A reopening answers one specific rule. Topics gain tags over time, so the
      // rule that governs a topic can change with no new feedback event: a later
      // rule may start to match. Apply only a reopening the model judged against
      // the rule that governs now; a different rule was never judged.
      const reopen = this.events('reopen')
        .filter(
          (e) =>
            e.payload.topicId === topicId &&
            e.seq > governing &&
            e.payload.feedbackId === current.feedbackId &&
            e.payload.ruleIndex === current.ruleIndex,
        )
        .at(-1);
      if (reopen)
        current = {
          status: 'open',
          reason: reopen.payload.reason,
          feedbackId: current.feedbackId,
          ruleIndex: current.ruleIndex,
          reopenedByChange: true,
        };
    }
    if (
      current.status === 'deferred' &&
      current.resumeAt &&
      Date.parse(now) >= Date.parse(current.resumeAt)
    )
      current = { ...current, status: 'open', resumedByUserDeadline: true };
    const receipts = this.events('delivery').filter((e) => e.payload.topicIds.includes(topicId));
    const withheld = this.events('withheld').filter((e) => e.payload.topicId === topicId);
    // Display 'sent' without destroying the user's open/deferred/closed policy.
    return {
      ...current,
      displayStatus: current.status === 'open' && receipts.length ? 'sent' : current.status,
      receipts,
      withheld,
    };
  }
  recordFeedback({
    id,
    text,
    at = this.clock(),
    replyTo = null,
  }: {
    id: string;
    text: string;
    at?: string;
    replyTo?: string | null;
  }) {
    requireThat(nonempty(text) && iso(at), 'Feedback text and time required');
    requireThat(
      this.event(replyTo ?? '')?.kind === 'delivery',
      'Feedback reply must reference an actual delivery',
    );
    return this.put(id, 'feedback', { text, replyTo }, at);
  }
  appendNote(note: any, id: string, recordedAt = this.clock()) {
    requireThat(
      note &&
        Object.keys(note).every((k) =>
          ['topicId', 'title', 'text', 'occurredAt', 'sources', 'tags', 'related'].includes(k),
        ),
      'Unsupported note field',
    );
    requireThat(
      nonempty(note.topicId) && nonempty(note.title) && nonempty(note.text),
      'Missing note content',
    );
    requireThat(note.occurredAt == null || nonempty(note.occurredAt), 'Invalid occurrence time');
    requireThat(
      strings(note.sources) && note.sources.length > 0 && strings(note.tags ?? []),
      'Information sources required',
    );
    requireThat(strings(note.related ?? []), 'Related topics must be IDs');
    const old = this.topics().get(note.topicId);
    requireThat(
      !old || old.title === note.title,
      'Append corrections instead of renaming old topics',
    );
    return this.put(
      id,
      'note',
      {
        ...note,
        occurredAt: note.occurredAt ?? null,
        tags: note.tags ?? [],
        related: note.related ?? [],
      },
      recordedAt,
    );
  }
  resolveFeedback(resolution: any, id: string) {
    const { feedbackId, understanding, rules } = resolution;
    const feedback = this.event(feedbackId);
    requireThat(
      this.feedback().some((e) => e.id === feedbackId) &&
        nonempty(understanding) &&
        Array.isArray(rules),
      'Real user feedback and interpretation required',
    );
    requireThat(
      !this.events('feedback-resolution').some((e) => e.payload.feedbackId === feedbackId),
      'Feedback already interpreted',
    );
    for (const rule of rules) {
      requireThat(
        Object.keys(rule).every((k) =>
          ['quote', 'status', 'reason', 'resumeAt', 'topicIds', 'tags'].includes(k),
        ),
        'Unsupported feedback rule field',
      );
      requireThat(
        nonempty(rule.quote) && feedback.payload.text.includes(rule.quote),
        'State changes must cite user feedback verbatim',
      );
      requireThat(['open', 'deferred', 'closed'].includes(rule.status), 'Invalid feedback state');
      requireThat(
        strings(rule.topicIds) && strings(rule.tags) && rule.topicIds.length + rule.tags.length > 0,
        'Explicit feedback scope required',
      );
      requireThat(
        rule.topicIds.every((x: string) => this.topics().has(x)),
        'Unknown feedback target',
      );
      requireThat(
        !rule.resumeAt || iso(rule.resumeAt),
        'Resume time must be absolute with timezone',
      );
      requireThat(rule.status !== 'closed' || nonempty(rule.reason), 'Closing requires a reason');
      requireThat(
        rule.status !== 'deferred' || nonempty(rule.reason) || rule.resumeAt,
        'Deferring requires a reason or resume time',
      );
      requireThat(
        rule.status === 'deferred' || !rule.resumeAt,
        'Only deferred rules have a resume time',
      );
    }
    return this.put(id, 'feedback-resolution', resolution);
  }
  /**
   * The judgement looked into a topic and chose not to tell the user. This is
   * neither "investigated" (notes) nor "told" (delivery receipts), and it is not
   * a ban: a later message about the topic is still allowed.
   */
  recordWithheld(entry: any, id: string) {
    requireThat(
      entry &&
        Object.keys(entry).every((k) => ['topicId', 'reason'].includes(k)) &&
        nonempty(entry.topicId) &&
        nonempty(entry.reason),
      'Withheld needs a topic and a reason',
    );
    requireThat(this.topics().has(entry.topicId), 'Unknown withheld topic');
    return this.put(id, 'withheld', entry);
  }
  /**
   * A closed or deferred topic becomes open again because its underlying
   * information changed, not because the user said so. The change must be in the
   * notebook: a note on this topic recorded after the user feedback that governs
   * it. The user's own later feedback still overrides this.
   */
  reopenTopic(entry: any, id: string) {
    requireThat(
      entry &&
        Object.keys(entry).every((k) => ['topicId', 'reason'].includes(k)) &&
        nonempty(entry.topicId) &&
        nonempty(entry.reason),
      'Reopening needs a topic and a reason',
    );
    requireThat(this.topics().has(entry.topicId), 'Unknown reopened topic');
    const current = this.state(entry.topicId);
    requireThat(
      current.feedbackId && ['closed', 'deferred'].includes(current.status),
      'Only a topic the user closed or deferred can be reopened',
    );
    const governing = this.event(current.feedbackId)!.seq;
    requireThat(
      this.events('note').some((e) => e.payload.topicId === entry.topicId && e.seq > governing),
      'Reopening needs a note on this topic recorded after the user feedback',
    );
    // Bind the reopening to the rule it was validated against (see state()).
    return this.put(id, 'reopen', {
      ...entry,
      feedbackId: current.feedbackId,
      ruleIndex: current.ruleIndex,
    });
  }
  commitDraft({
    role,
    operationId,
    expectedFeedbackRevision,
    draft,
  }: {
    role: string;
    operationId: string;
    expectedFeedbackRevision: number;
    draft: any;
  }) {
    requireThat(['exploration', 'judgement'].includes(role), 'Unknown role');
    const digest = fingerprint({ role, expectedFeedbackRevision, draft });
    return this.transaction(() => {
      const prior = this.event(operationId);
      if (prior) {
        requireThat(
          prior.kind === 'draft' && prior.payload.digest === digest,
          'Draft operation ID conflict',
        );
        return prior.payload.result;
      }
      requireThat(
        this.revision() === expectedFeedbackRevision,
        'FEEDBACK_CHANGED: refresh feedback before committing',
      );
      requireThat(
        draft &&
          Object.keys(draft).every((k) =>
            ['notes', 'feedbackDecisions', 'messages', 'withheld', 'reopened'].includes(k),
          ),
        'Unsupported draft field',
      );
      const {
        notes = [],
        feedbackDecisions = [],
        messages = [],
        withheld = [],
        reopened = [],
      } = draft;
      requireThat(
        [notes, feedbackDecisions, messages, withheld, reopened].every(Array.isArray),
        'Draft operations must be arrays',
      );
      requireThat(
        role === 'judgement' ||
          (!feedbackDecisions.length && !messages.length && !withheld.length && !reopened.length),
        'Exploration only appends knowledge',
      );
      notes.forEach((n: any, i: number) => this.appendNote(n, `${operationId}:note:${i}`));
      feedbackDecisions.forEach((f: any, i: number) =>
        this.resolveFeedback(f, `${operationId}:feedback:${i}`),
      );
      if (role === 'judgement')
        requireThat(
          this.pendingFeedback().length === 0,
          'Read and interpret pending user feedback first',
        );
      withheld.forEach((w: any, i: number) =>
        this.recordWithheld(w, `${operationId}:withheld:${i}`),
      );
      reopened.forEach((r: any, i: number) => this.reopenTopic(r, `${operationId}:reopened:${i}`));
      const preparedIds: string[] = [];
      messages.forEach((m: any, i: number) => {
        requireThat(
          Object.keys(m).every((k) => ['text', 'topicIds'].includes(k)) &&
            nonempty(m.text) &&
            strings(m.topicIds) &&
            m.topicIds.length,
          'Message text and related topics required',
        );
        // Topic state informs the agent; it is not a ban on discussing that topic.
        const topics = this.topics();
        requireThat(
          m.topicIds.every((t: string) => topics.has(t)),
          'Unknown message topic',
        );
        const id = `${operationId}:message:${i}`;
        this.put(id, 'prepared', { ...m, feedbackRevision: this.revision() });
        preparedIds.push(id);
      });
      const result = {
        preparedIds,
        notesAdded: notes.length,
        feedbackProcessed: feedbackDecisions.length,
        withheldRecorded: withheld.length,
        topicsReopened: reopened.length,
      };
      this.put(operationId, 'draft', { digest, result });
      return result;
    });
  }
  async deliver(preparedId: string, sender: (args: any) => Promise<any>, transport: string) {
    requireThat(nonempty(transport), 'Delivery transport label required');
    const receiptId = `${preparedId}:delivered`;
    if (this.event(receiptId)) return this.event(receiptId);
    requireThat(!this.delivering, 'Another send is in progress');
    const event = this.event(preparedId);
    requireThat(event?.kind === 'prepared', 'Unknown prepared message');
    const m = event.payload;
    requireThat(
      this.revision() === m.feedbackRevision && !this.pendingFeedback().length,
      'FEEDBACK_CHANGED: re-evaluate prepared message',
    );
    this.delivering = true;
    try {
      // The transport must deduplicate this stable key after a process crash.
      const ack = await sender({ messageId: preparedId, messages: [{ text: m.text }] });
      requireThat(
        ack?.delivered === true && strings(ack.messageIds) && ack.messageIds.length > 0,
        'No confirmed delivery receipt',
      );
      this.put(receiptId, 'delivery', {
        preparedId,
        topicIds: m.topicIds,
        text: m.text,
        transport,
        messageIds: ack.messageIds,
      });
      return this.event(receiptId);
    } finally {
      this.delivering = false;
    }
  }
  render({
    topicIds = null,
    now = this.clock(),
  }: {
    topicIds?: string[] | null;
    now?: string;
  } = {}) {
    const lines = [
      '# 用户相关世界的记事本',
      '',
      '内容是参考资料；用户反馈需结合原话、范围和时间理解。开放表示方向未被用户关闭，不表示事情仍在进行。爱好可能长期持续，具体事情会过去；发生时间未知时结合正文与来源判断，不以记录时间代替。',
      '',
      '## 用户反馈',
    ];
    const pending = new Set(this.pendingFeedback().map((x) => x.id));
    for (const f of this.feedback())
      lines.push(
        `- ${f.at}｜${f.id}｜${pending.has(f.id) ? '待理解' : '已理解'}${f.payload.replyTo ? '｜回复 ' + f.payload.replyTo + '｜主题：' + this.event(f.payload.replyTo).payload.topicIds.join('、') : ''}\n  ${f.payload.text}`,
      );
    if (!this.feedback().length) lines.push('暂无用户反馈。');
    const rules = this.feedbackResolutions().flatMap((e) =>
      e.payload.rules.map((r: any) => ({
        ...r,
        feedbackId: e.payload.feedbackId,
      })),
    );
    if (rules.length) {
      lines.push('', '## 用户反馈的范围与依据');
      for (const r of rules)
        lines.push(
          `- ${r.status}｜主题：${r.topicIds.join('、') || '无'}｜方向：${r.tags.join('、') || '无'}｜依据 ${r.feedbackId}：“${r.quote}”｜原因：${r.reason || '按用户给定时间'}${r.resumeAt ? '｜恢复时间：' + r.resumeAt : ''}`,
        );
      lines.push('以上按反馈顺序记录；较新的相关用户反馈修正之前的状态，主题下展示当前状态。');
    }
    for (const topic of this.topics().values()) {
      if (topicIds && !topicIds.includes(topic.id)) continue;
      const s = this.state(topic.id, now);
      const labels: Record<string, string> = {
        open: '开放',
        sent: '已发送',
        deferred: '暂缓',
        closed: '关闭',
      };
      lines.push(
        '',
        `## ${topic.title}〔${topic.id}〕`,
        `状态：${labels[s.displayStatus]}${s.reopenedByChange ? '（因信息出现重大变化，经判断重新开放）' : ''}${s.reason ? '；原因：' + s.reason : ''}${s.feedbackId ? '；依据：' + s.feedbackId : ''}`,
        `方向：${topic.tags.join('、') || '未分类'}`,
      );
      if (s.resumeAt) lines.push(`用户指定恢复时间：${s.resumeAt}`);
      for (const n of topic.notes)
        lines.push(
          `- ${n.text}\n  发生时间：${n.occurredAt ?? '未知'}｜记录时间：${n.recordedAt}\n  来源：${n.sources.join('；')}${n.related?.length ? '\n  关联主题：' + n.related.join('、') : ''}`,
        );
      for (const r of s.receipts) lines.push(`- 已发送 ${r.at}〔${r.id}〕：${r.payload.text}`);
      for (const w of s.withheld)
        lines.push(`- 已调查但未告知用户 ${w.at}〔${w.id}〕：${w.payload.reason}`);
    }
    const quickDeliveries = this.events('delivery').filter(
      (e) => e.payload.origin === 'quick-discovery' && !e.payload.topicIds.length,
    );
    if (quickDeliveries.length) {
      lines.push(
        '',
        '## 高频发现已发送的消息',
        '以下是用户实际收到的正文，不代表待办；对应反馈见上方。',
      );
      for (const e of quickDeliveries) lines.push(`- ${e.at}〔${e.id}〕：${e.payload.text}`);
    }
    lines.push('', '## 已交给 Bot 的文案（不代表已送达）');
    for (const e of this.events('reported')) lines.push(`- ${e.at}：${e.payload.text}`);
    return lines.join('\n') + '\n';
  }
}
