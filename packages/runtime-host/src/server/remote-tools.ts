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

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { REMOTE_TOOLS_RESULT_BYTES, type RemoteToolsRequest } from '../protocol/remote-tools.js';
import type { InboxInput } from '../assistant/bot/store.js';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { BOT_DELEGATION_TOOLS } from '../assistant/bot/capabilities.js';

// The single origin Bot owns communication/lifecycle; all its business tools run on targets.
export const REMOTE_TOOL_NAMES = new Set([
  ...BOT_DELEGATION_TOOLS,
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  'WriteStdin',
  'StopBackgroundTask',
  'MemorySourceQuery',
  'MemoryStatus',
]);
interface RemoteContext {
  id: string;
  principal: string;
  originHost: string;
  originSession: string;
  templateSession: string;
  sessionId: string;
}
interface Dependencies {
  origin?(sessionId: string): string;
  list(): Promise<unknown>;
  create(template: string, label: string): Promise<string>;
  tools(sessionId: string): Promise<readonly MakaTool[]>;
  execute(
    sessionId: string,
    callId: string,
    tool: MakaTool,
    args: unknown,
    event: (value: unknown) => void,
    signal: AbortSignal,
  ): Promise<unknown>;
  deliver(sessionId: string, input: InboxInput): boolean | 'manual_only';
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class RemoteToolsHost {
  private readonly db: DatabaseSync;
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly cancellations = new Map<string, AbortController>();
  private opening: Promise<unknown> = Promise.resolve();
  constructor(
    directory: string,
    private readonly deps: Dependencies,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'remote-tools.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,context TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS trace(seq INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,principal TEXT NOT NULL,origin_host TEXT NOT NULL,origin_session TEXT NOT NULL,payload TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((c) => c.name === 'call_id')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN call_id TEXT');
    // No re-execution after a process dies between an effect and its receipt.
    const interrupted = this.db
      .prepare("SELECT id,context,call_id FROM calls WHERE status='running'")
      .all();
    this.db.exec("UPDATE calls SET status='outcome_unknown' WHERE status='running'");
    for (const row of interrupted) {
      const c = this.context(String(row.context));
      this.emit(c, String(row.id), {
        contextId: c.id,
        callId: row.call_id ?? null,
        status: 'outcome_unknown',
        message:
          'Host restarted before this tool call had a durable outcome. Inspect target state before retrying.',
      });
    }
  }
  private context(id: string, principal?: string): RemoteContext {
    const row = this.db.prepare('SELECT payload FROM contexts WHERE id=?').get(id);
    if (!row) throw Error('Remote execution context not found');
    const context = JSON.parse(String(row.payload)) as RemoteContext;
    if (principal && context.principal !== principal)
      throw Error('Remote context belongs to another principal');
    return context;
  }
  private receipt(context: RemoteContext, callId: string) {
    const row = this.db
      .prepare('SELECT status,result FROM calls WHERE id=? AND context=?')
      .get(digest([context.id, callId]), context.id);
    if (!row) return { callId, contextId: context.id, status: 'not_found' };
    const bytes = row.result ? Buffer.byteLength(String(row.result)) : 0;
    return {
      callId,
      contextId: context.id,
      status: row.status,
      ...(bytes > REMOTE_TOOLS_RESULT_BYTES - 8192
        ? {
            resultUnavailable: {
              code: 'result_too_large',
              bytes,
              message:
                'Full result retained on target. Execution is settled; do not repeat a mutation. For reads, issue a smaller paginated query with a new callId.',
            },
          }
        : row.result
          ? { result: JSON.parse(String(row.result)) }
          : {}),
    };
  }
  private emit(context: RemoteContext, id: string, payload: unknown) {
    const existing = this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id);
    if (existing && existing.payload !== JSON.stringify(payload))
      throw Error('Remote feedback identity conflict');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO outbox(id,principal,origin_host,origin_session,payload) VALUES(?,?,?,?,?)',
      )
      .run(
        id,
        context.principal,
        context.originHost,
        context.originSession,
        JSON.stringify(payload),
      );
  }
  ownsSession(sessionId: string): boolean {
    return this.db
      .prepare('SELECT payload FROM contexts')
      .all()
      .some((row) => JSON.parse(String(row.payload)).sessionId === sessionId);
  }
  feedback(owner: string, input: InboxInput): boolean {
    for (const row of this.db.prepare('SELECT payload FROM contexts').all()) {
      const c = JSON.parse(String(row.payload)) as RemoteContext;
      if (c.sessionId !== owner) continue;
      this.emit(c, digest([c.id, input.id]), { contextId: c.id, ...input });
      return true;
    }
    return false;
  }
  async request(raw: RemoteToolsRequest, principal: string): Promise<unknown> {
    this.abort.signal.throwIfAborted();
    if (raw.action === 'origin')
      return { sessionId: this.deps.origin?.(raw.sessionId) ?? raw.sessionId };
    if (raw.action === 'contexts') return this.deps.list();
    if (raw.action === 'open') {
      const next = this.opening.then(async () => {
        const id = digest([principal, raw.originHost, raw.originSession, raw.templateSession]);
        const existing = this.db.prepare('SELECT payload FROM contexts WHERE id=?').get(id);
        if (existing) return JSON.parse(String(existing.payload));
        const sessionId = await this.deps.create(raw.templateSession, `remote-context:${id}`);
        const context: RemoteContext = {
          id,
          principal,
          originHost: raw.originHost,
          originSession: raw.originSession,
          templateSession: raw.templateSession,
          sessionId,
        };
        this.db.prepare('INSERT INTO contexts VALUES(?,?)').run(id, JSON.stringify(context));
        return context;
      });
      this.opening = next.catch(() => {});
      return next;
    }
    if (raw.action === 'events') {
      const events: { id: unknown; sessionId: unknown; content: unknown }[] = [];
      let bytes = 0;
      for (const row of this.db
        .prepare(
          'SELECT id,origin_session,payload FROM outbox WHERE principal=? AND origin_host=? AND acked=0 ORDER BY rowid LIMIT 100',
        )
        .all(principal, raw.originHost)) {
        let content = JSON.parse(String(row.payload));
        if (Buffer.byteLength(String(row.payload)) > REMOTE_TOOLS_RESULT_BYTES - 8192)
          content = {
            contextId: content.contextId,
            callId: content.callId,
            status: content.status,
            error:
              'Feedback exceeds transport budget; full content retained on target. Query the task/index or a smaller page. Do not repeat completed work.',
          };
        const event = { id: row.id, sessionId: row.origin_session, content };
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length && bytes + size > REMOTE_TOOLS_RESULT_BYTES - 4096) break;
        events.push(event);
        bytes += size + 1;
      }
      return events;
    }
    if (raw.action === 'ack') {
      for (const id of raw.ids)
        this.db.prepare('UPDATE outbox SET acked=1 WHERE id=? AND principal=?').run(id, principal);
      return { acknowledged: true };
    }
    if (raw.action === 'deliver') {
      const content = raw.content as { type?: string; taskId?: string } | null;
      const result = this.deps.deliver(raw.sessionId, {
        id: raw.id,
        type:
          content?.type === 'task_update'
            ? 'task_update'
            : content?.type === 'discovery'
              ? 'discovery'
              : 'system_event',
        source: raw.source,
        content: raw.content,
      });
      return { accepted: result === true, manualOnly: result === 'manual_only' };
    }
    const context = this.context(raw.contextId, principal);
    if (raw.origin.hostId !== context.originHost || raw.origin.sessionId !== context.originSession)
      throw Error('Remote context belongs to another origin conversation');
    if (raw.action === 'cancel') {
      this.cancellations
        .get(digest([context.id, raw.callId]))
        ?.abort(Error('Remote call cancelled by user'));
      return { cancellationRequested: true, ...this.receipt(context, raw.callId) };
    }
    if (raw.action === 'result') return this.receipt(context, raw.callId);
    const tools = (await this.deps.tools(context.sessionId)).filter((t) =>
      REMOTE_TOOL_NAMES.has(t.name),
    );
    if (raw.action === 'search')
      return {
        contextId: context.id,
        sessionId: context.sessionId,
        tools: tools
          .filter((t) => {
            const terms = raw.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
            const text = `${t.name} ${t.description}`.toLowerCase();
            return terms.length === 0 || terms.some((term) => text.includes(term));
          })
          .map((t) => ({
            name: t.name,
            description: t.description,
            parameters:
              t.parameters instanceof z.ZodType
                ? z.toJSONSchema(t.parameters, { unrepresentable: 'any', io: 'input' })
                : t.parameters,
            executionSemantics: t.executionSemantics,
            recoveryMode: t.recoveryMode,
          })),
        notice:
          'References, paths, task IDs and cursors belong to this target Host and context. Follow-up operations must use the same context. No model is started for a tool call.',
      };
    const key = digest([context.id, raw.callId]);
    const fingerprint = canonicalToolArgsHash(raw.tool, raw.arguments);
    const prior = this.db.prepare('SELECT fingerprint FROM calls WHERE id=?').get(key);
    if (prior) {
      if (
        prior.fingerprint !== fingerprint &&
        prior.fingerprint !== digest([raw.tool, raw.arguments])
      )
        throw Error('callId already identifies different arguments');
      return this.receipt(context, raw.callId);
    }
    const tool = tools.find((t) => t.name === raw.tool);
    if (!tool) throw Error('Tool is not exported by this Host; discover available tools first');
    const args =
      tool.parameters instanceof z.ZodType ? tool.parameters.parse(raw.arguments) : raw.arguments;
    if (this.db.prepare("SELECT 1 FROM calls WHERE context=? AND status='running'").get(context.id))
      throw Error(
        'Remote context has an active tool call; read its result before starting another',
      );
    this.db
      .prepare(
        'INSERT INTO calls(id,context,fingerprint,status,result,call_id) VALUES(?,?,?,?,NULL,?)',
      )
      .run(key, context.id, fingerprint, 'running', raw.callId);
    const cancellation = new AbortController();
    this.cancellations.set(key, cancellation);
    let deferred = false;
    const work = Promise.resolve().then(async () => {
      let result: unknown;
      let status = 'completed';
      try {
        result = await this.deps.execute(
          context.sessionId,
          key,
          tool,
          args,
          (event) => {
            this.db
              .prepare('INSERT INTO trace(call_id,payload) VALUES(?,?)')
              .run(key, JSON.stringify(event));
          },
          AbortSignal.any([this.abort.signal, cancellation.signal]),
        );
      } catch (error) {
        status = 'outcome_unknown';
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      const serialized = JSON.stringify(result ?? null);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .prepare('UPDATE calls SET status=?,result=? WHERE id=?')
          .run(status, serialized, key);
        if (deferred)
          this.emit(context, key, { tool: raw.tool, ...this.receipt(context, raw.callId) });
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    this.active.set(key, work);
    void work
      .finally(() => {
        this.active.delete(key);
        this.cancellations.delete(key);
      })
      .catch(() => {});
    // Short operations return inline. Longer operations remain owned by this Host.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    deferred = true;
    return this.receipt(context, raw.callId);
  }
  beginDrain() {
    this.abort.abort(Error('Remote tools Host is draining'));
  }
  async close() {
    this.abort.abort(Error('Remote tools Host is closing'));
    await this.opening;
    await Promise.allSettled(this.active.values());
    this.db.close();
  }
}
