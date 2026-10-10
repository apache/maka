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

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const EXECUTOR_ID = 'codex.app-server';

const MAX_EVENT_TEXT = 8_000;
const MAX_MODEL_LIST_PAGES = 10;
const VALID_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_REASONING_EFFORTS = new Set([
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function normalizeConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const codexPath = typeof source.codexPath === 'string' ? source.codexPath.trim() : 'codex';
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  const sandbox = typeof source.sandbox === 'string' ? source.sandbox : 'read-only';
  const ephemeralThreads = source.ephemeralThreads ?? true;
  const disposeGraceMs = source.disposeGraceMs ?? 3_000;
  const rpcTimeoutMs = source.rpcTimeoutMs ?? 30_000;
  const inheritEnvironmentCredentials = source.inheritEnvironmentCredentials ?? false;

  if (!codexPath || /[\0\r\n]/u.test(codexPath)) {
    throw new TypeError('Codex executor requires a valid executable path or command name');
  }
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new TypeError(`Unsupported Codex sandbox: ${String(sandbox)}`);
  }
  if (typeof ephemeralThreads !== 'boolean') {
    throw new TypeError('ephemeralThreads must be a boolean');
  }
  if (!Number.isSafeInteger(disposeGraceMs) || disposeGraceMs < 100 || disposeGraceMs > 30_000) {
    throw new TypeError('disposeGraceMs must be an integer between 100 and 30000');
  }
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1_000 || rpcTimeoutMs > 120_000) {
    throw new TypeError('rpcTimeoutMs must be an integer between 1000 and 120000');
  }
  if (typeof inheritEnvironmentCredentials !== 'boolean') {
    throw new TypeError('inheritEnvironmentCredentials must be a boolean');
  }

  return Object.freeze({
    codexPath,
    ...(model ? { model } : {}),
    sandbox,
    ephemeralThreads,
    disposeGraceMs,
    rpcTimeoutMs,
    inheritEnvironmentCredentials,
  });
}

export class CodexAppServerClient {
  constructor(config, logger, options = {}) {
    this.config = normalizeConfig(config);
    this.logger = logger ?? silentLogger;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.process = undefined;
    this.reader = undefined;
    this.starting = undefined;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map();
    this.threadStarts = new Map();
    this.activeTurns = new Map();
  }

  async execute(request, context) {
    if (!request.text.trim()) {
      return Object.freeze({
        status: 'failed',
        message: 'Codex executor requires non-empty text input',
        code: 'codex_empty_input',
        recoverable: false,
      });
    }
    if (request.attachments?.length) {
      return Object.freeze({
        status: 'failed',
        message: 'Codex App Server Executor does not support Maka attachment inputs yet',
        code: 'codex_attachments_unsupported',
        recoverable: false,
      });
    }

    context.signal.throwIfAborted();
    try {
      await this.ensureStarted();
      context.signal.throwIfAborted();
      const threadId = await this.thread(request);
      context.signal.throwIfAborted();
      return await this.turn(threadId, request, context);
    } catch (error) {
      if (context.signal.aborted) {
        return Object.freeze({
          status: 'cancelled',
          reason: 'Maka cancelled the Codex turn',
        });
      }
      return Object.freeze({
        status: 'failed',
        message: errorMessage(error),
        code: 'codex_app_server_request_failed',
        recoverable: isRecoverable(error),
      });
    }
  }

  async models() {
    await this.ensureStarted();
    const result = [];
    let cursor;
    let pages = 0;
    const seenCursors = new Set();
    do {
      pages += 1;
      const response = await this.request('model/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const items = Array.isArray(response?.data) ? response.data : [];
      for (const value of items) {
        if (!value || typeof value !== 'object' || typeof value.model !== 'string') continue;
        const efforts = Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts
              .filter(
                (effort) =>
                  effort &&
                  typeof effort === 'object' &&
                  VALID_REASONING_EFFORTS.has(effort.reasoningEffort),
              )
              .map((effort) => ({
                reasoningEffort: effort.reasoningEffort === 'none' ? 'off' : effort.reasoningEffort,
                ...(typeof effort.description === 'string'
                  ? { description: effort.description }
                  : {}),
              }))
          : [];
        result.push({
          model: value.model,
          displayName:
            typeof value.displayName === 'string' && value.displayName.trim()
              ? value.displayName
              : value.model,
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
          isDefault: value.isDefault === true,
          ...(VALID_REASONING_EFFORTS.has(value.defaultReasoningEffort)
            ? {
                defaultReasoningEffort:
                  value.defaultReasoningEffort === 'none' ? 'off' : value.defaultReasoningEffort,
              }
            : {}),
          supportedReasoningEfforts: efforts,
        });
      }
      const nextCursor =
        typeof response?.nextCursor === 'string' && response.nextCursor
          ? response.nextCursor
          : undefined;
      cursor = nextCursor && !seenCursors.has(nextCursor) ? nextCursor : undefined;
      if (cursor) seenCursors.add(cursor);
    } while (cursor && result.length < 500 && pages < MAX_MODEL_LIST_PAGES);
    return result.slice(0, 500);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.process;
    this.process = undefined;
    this.reader?.close();
    this.reader = undefined;
    this.threads.clear();
    this.threadStarts.clear();
    this.failAll(new Error('Codex app-server client was closed'));
    await terminateChild(child, this.config.disposeGraceMs);
  }

  async ensureStarted() {
    if (this.closed) throw new Error('Codex app-server client is closed');
    if (this.starting) return await this.starting;
    if (this.process) return;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async start() {
    const child = this.spawnProcess(
      resolveCodexExecutable(this.config.codexPath),
      ['app-server', '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnvironment(this.config.inheritEnvironmentCredentials),
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    this.process = child;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.acceptLine(line));
    child.stderr?.resume();
    child.once('error', (error) => this.handleExit(child, error));
    child.once('exit', (code, signal) => {
      this.handleExit(child, appServerExitError(code, signal));
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'maka_codex_app_server_executor',
          title: 'Maka Executor for Codex',
          version: '0.3.0',
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.notify('initialized', {});
    } catch (error) {
      await terminateChild(child, this.config.disposeGraceMs);
      this.handleExit(child, error);
      throw error;
    }
  }

  async thread(request) {
    const existing = this.threads.get(request.conversationKey);
    if (existing) return existing;
    const starting = this.threadStarts.get(request.conversationKey);
    if (starting) return await starting;

    const task = (async () => {
      const model = request.model ?? this.config.model;
      const response = await this.request('thread/start', {
        ...(model ? { model } : {}),
        cwd: request.cwd,
        approvalPolicy: 'never',
        sandbox: this.config.sandbox,
        ephemeral: this.config.ephemeralThreads,
        ...(request.instructions ? { developerInstructions: request.instructions } : {}),
        serviceName: 'maka',
        threadSource: 'maka_plugin_executor',
      });
      const threadId = requireString(response?.thread?.id, 'thread id');
      this.threads.set(request.conversationKey, threadId);
      return threadId;
    })();
    this.threadStarts.set(request.conversationKey, task);
    try {
      return await task;
    } finally {
      if (this.threadStarts.get(request.conversationKey) === task) {
        this.threadStarts.delete(request.conversationKey);
      }
    }
  }

  async turn(threadId, request, context) {
    if (this.activeTurns.has(threadId)) {
      throw new Error(`Codex conversation is already running: ${request.conversationKey}`);
    }
    const completion = Promise.withResolvers();
    const active = {
      conversationKey: request.conversationKey,
      turnId: undefined,
      output: '',
      finalText: undefined,
      unphasedText: undefined,
      lastError: undefined,
      tools: new Map(),
      context,
      resolve: completion.resolve,
      settled: false,
      interruptTimer: undefined,
    };
    this.activeTurns.set(threadId, active);

    const interrupt = () => {
      if (!active.turnId || active.settled || active.interruptTimer) return;
      active.interruptTimer = setTimeout(() => {
        this.forceCancelledTurn(threadId, active);
      }, this.config.rpcTimeoutMs);
      active.interruptTimer.unref?.();
      void this.request('turn/interrupt', {
        threadId,
        turnId: active.turnId,
      }).catch(() => this.forceCancelledTurn(threadId, active));
    };
    context.signal.addEventListener('abort', interrupt, { once: true });
    try {
      const started = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: requestText(request), text_elements: [] }],
        cwd: request.cwd,
        model: request.model,
        effort: request.reasoningEffort === 'off' ? 'none' : request.reasoningEffort,
      });
      active.turnId = requireString(started?.turn?.id, 'turn id');
      if (context.signal.aborted) interrupt();
      return await completion.promise;
    } catch (error) {
      this.finishTurn(threadId, active, {
        status: context.signal.aborted ? 'cancelled' : 'failed',
        ...(context.signal.aborted
          ? { reason: 'Maka cancelled the Codex turn' }
          : {
              message: errorMessage(error),
              code: 'codex_app_server_request_failed',
              recoverable: isRecoverable(error),
            }),
      });
      return await completion.promise;
    } finally {
      context.signal.removeEventListener('abort', interrupt);
      if (this.activeTurns.get(threadId) === active && active.settled) {
        this.activeTurns.delete(threadId);
      }
    }
  }

  request(method, params) {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is unavailable'));
    }
    const id = this.nextId++;
    const completion = Promise.withResolvers();
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error(`Codex app-server request timed out: ${method}`));
    }, this.config.rpcTimeoutMs);
    timer.unref?.();
    this.pending.set(id, {
      resolve: completion.resolve,
      reject: completion.reject,
      cleanup: () => clearTimeout(timer),
    });
    try {
      this.write({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.cleanup();
      completion.reject(error);
    }
    return completion.promise;
  }

  notify(method, params) {
    this.write({ method, params });
  }

  write(message) {
    if (!this.process?.stdin.writable) throw new Error('Codex app-server stdin is unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  acceptLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn('Ignoring invalid JSON from Codex app-server');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.logger.warn('Ignoring invalid message from Codex app-server');
      return;
    }
    if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new Error(formatRpcError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    if (Object.hasOwn(message, 'id')) {
      this.respondToServerRequest(message);
      return;
    }
    this.acceptNotification(message.method, message.params);
  }

  respondToServerRequest(message) {
    let response;
    try {
      const result = declineServerRequest(message.method);
      response = { id: message.id, result };
    } catch (error) {
      response = {
        id: message.id,
        error: { code: -32601, message: errorMessage(error) },
      };
    }
    try {
      this.write(response);
    } catch {
      this.logger.warn('Could not respond to Codex app-server request after transport closed');
    }
  }

  acceptNotification(method, params) {
    const threadId = params?.threadId;
    if (typeof threadId !== 'string') return;
    const active = this.activeTurns.get(threadId);
    if (!active) return;
    const notificationTurnId = params?.turnId ?? params?.turn?.id;
    if (typeof notificationTurnId === 'string') {
      if (active.turnId && active.turnId !== notificationTurnId) return;
      active.turnId ||= notificationTurnId;
    }

    if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
      active.output += params.delta;
      emitText(active.context, 'output_delta', params.delta);
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta' && typeof params?.delta === 'string') {
      emitText(active.context, 'thinking_delta', params.delta);
      return;
    }
    if (method === 'item/started') {
      const event = toolStartEvent(params?.item);
      if (event) {
        active.tools.set(event.toolCallId, params.item.type);
        active.context.emit(event);
      }
      return;
    }
    if (
      method === 'item/commandExecution/outputDelta' &&
      typeof params?.itemId === 'string' &&
      typeof params?.delta === 'string' &&
      active.tools.has(params.itemId)
    ) {
      emitText(active.context, 'tool_progress', params.delta, {
        toolCallId: params.itemId,
      });
      return;
    }
    if (
      method === 'item/mcpToolCall/progress' &&
      typeof params?.itemId === 'string' &&
      typeof params?.message === 'string' &&
      active.tools.has(params.itemId)
    ) {
      emitText(active.context, 'tool_progress', params.message, {
        toolCallId: params.itemId,
      });
      return;
    }
    if (method === 'item/completed') {
      const item = params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        if (item.phase === 'final_answer') active.finalText = item.text;
        else if (item.phase === null || item.phase === undefined) active.unphasedText = item.text;
      }
      if (item && active.tools.has(item.id)) {
        active.tools.delete(item.id);
        active.context.emit(toolResultEvent(item));
      }
      return;
    }
    if (method === 'error') {
      active.lastError = params?.error;
      return;
    }
    if (method !== 'turn/completed') return;

    const status = params?.turn?.status;
    if (status === 'completed') {
      this.finishTurn(threadId, active, {
        status: 'completed',
        text: active.finalText ?? active.unphasedText ?? active.output,
      });
      return;
    }
    if (status === 'interrupted') {
      this.finishTurn(threadId, active, {
        status: 'cancelled',
        reason: 'Codex turn interrupted',
      });
      return;
    }
    this.finishTurn(threadId, active, {
      status: 'failed',
      message: errorMessage(params?.turn?.error ?? active.lastError ?? 'Codex turn failed'),
      code: 'codex_turn_failed',
      recoverable: true,
    });
  }

  finishTurn(threadId, active, result) {
    if (active.settled) return;
    active.settled = true;
    if (active.interruptTimer) clearTimeout(active.interruptTimer);
    active.interruptTimer = undefined;
    if (this.activeTurns.get(threadId) === active) this.activeTurns.delete(threadId);
    active.resolve(Object.freeze(result));
  }

  forceCancelledTurn(threadId, active) {
    if (active.settled) return;
    this.threads.delete(active.conversationKey);
    this.finishTurn(threadId, active, {
      status: 'cancelled',
      reason: 'Maka cancelled the Codex turn',
    });
    const child = this.process;
    if (child) void terminateChild(child, this.config.disposeGraceMs).catch(() => {});
  }

  handleExit(child, error) {
    if (this.process !== child) return;
    this.process = undefined;
    this.reader?.close();
    this.reader = undefined;
    this.threads.clear();
    this.threadStarts.clear();
    this.failAll(error);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const [threadId, active] of this.activeTurns) {
      this.finishTurn(threadId, active, {
        status: 'failed',
        message: errorMessage(error),
        code: 'codex_app_server_exited',
        recoverable: true,
      });
    }
  }
}

function requestText(request) {
  const sections = [request.text];
  if (request.quotes?.length) {
    sections.push(`Quoted context:\n${request.quotes.map(formatReference).join('\n')}`);
  }
  if (request.directoryReferences?.length) {
    sections.push(
      `Referenced directories:\n${request.directoryReferences.map(formatReference).join('\n')}`,
    );
  }
  return sections.filter(Boolean).join('\n\n');
}

function formatReference(value) {
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return safeJson(value);
}

function toolStartEvent(item) {
  if (!item || typeof item.id !== 'string') return undefined;
  if (item.type === 'commandExecution') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: 'codex.command',
      displayName: 'Codex command',
      activityKind: 'command',
      input: { command: item.command, cwd: item.cwd },
    });
  }
  if (item.type === 'fileChange') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: 'codex.file_change',
      displayName: 'Codex file change',
      activityKind: 'edit',
      input: summarizeFileChanges(item.changes),
    });
  }
  if (item.type === 'mcpToolCall') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: safeEventId(`codex.mcp.${item.server}.${item.tool}`),
      displayName: `Codex MCP: ${safeText(item.tool)}`,
      activityKind: 'tool',
      input: {
        server: item.server,
        tool: item.tool,
        arguments: boundedValue(item.arguments),
      },
    });
  }
  if (item.type === 'dynamicToolCall') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: safeEventId(`codex.dynamic.${item.tool}`),
      displayName: `Codex tool: ${safeText(item.tool)}`,
      activityKind: 'tool',
      input: { tool: item.tool, arguments: boundedValue(item.arguments) },
    });
  }
  if (item.type === 'webSearch') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: 'codex.web_search',
      displayName: 'Codex web search',
      activityKind: 'websearch',
      input: { query: item.query },
    });
  }
  if (item.type === 'imageView') {
    return Object.freeze({
      type: 'tool_start',
      toolCallId: item.id,
      name: 'codex.image_view',
      displayName: 'Codex image view',
      activityKind: 'read',
      input: { path: item.path },
    });
  }
  return undefined;
}

function toolResultEvent(item) {
  let text;
  let isError = false;
  if (item.type === 'commandExecution') {
    text = item.aggregatedOutput || `Command ${String(item.status)}`;
    if (item.exitCode !== null && item.exitCode !== undefined) {
      text = `${text}\nExit code: ${String(item.exitCode)}`;
    }
    isError = item.status === 'failed' || item.status === 'declined' || item.exitCode > 0;
  } else if (item.type === 'fileChange') {
    text = `File change ${String(item.status)} (${item.changes?.length ?? 0} file(s))`;
    isError = item.status === 'failed' || item.status === 'declined';
  } else if (item.type === 'mcpToolCall') {
    text = item.error ? errorMessage(item.error) : safeJson(item.result ?? item.status);
    isError = item.status === 'failed' || Boolean(item.error);
  } else if (item.type === 'dynamicToolCall') {
    text = safeJson(item.contentItems ?? item.status);
    isError = item.status === 'failed' || item.success === false;
  } else {
    text = `${String(item.type)} completed`;
  }
  return Object.freeze({
    type: 'tool_result',
    toolCallId: item.id,
    text: safeText(text),
    ...(isError ? { isError: true } : {}),
  });
}

function emitText(context, type, value, extra = {}) {
  const text = String(value).replaceAll('\r', '');
  if (!text) return;
  for (let index = 0; index < text.length; index += MAX_EVENT_TEXT) {
    context.emit(
      Object.freeze({
        type,
        ...extra,
        text: text.slice(index, index + MAX_EVENT_TEXT),
      }),
    );
  }
}

function summarizeFileChanges(changes) {
  if (!Array.isArray(changes)) return { files: [], count: 0 };
  return {
    files: changes.slice(0, 32).map((change) => ({ path: change?.path, kind: change?.kind })),
    count: changes.length,
  };
}

function boundedValue(value) {
  const text = safeJson(value);
  return text.length <= MAX_EVENT_TEXT ? value : { summary: safeText(text) };
}

function safeEventId(value) {
  const normalized = String(value).replace(/[\0\r\n]/gu, '_');
  return normalized.slice(0, 256) || 'codex.tool';
}

function safeText(value) {
  const normalized = String(value ?? '').replaceAll('\r', '');
  return normalized.length <= MAX_EVENT_TEXT ? normalized : `${normalized.slice(0, 7_999)}…`;
}

function safeJson(value) {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function declineServerRequest(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    default:
      throw new Error(`Unsupported Codex app-server request: ${method}`);
  }
}

const childTerminations = new WeakMap();

function terminateChild(child, graceMs) {
  if (!child) return Promise.resolve();
  const existing = childTerminations.get(child);
  if (existing) return existing;
  const termination = terminateChildOnce(child, graceMs);
  childTerminations.set(child, termination);
  return termination;
}

async function terminateChildOnce(child, graceMs) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('close', resolve);
    child.once('error', resolve);
  });
  signalProcessTree(child, 'SIGTERM');
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => timeout.resolve(false), graceMs);
  timer.unref?.();
  const graceful = await Promise.race([exited.then(() => true), timeout.promise]);
  clearTimeout(timer);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, 'SIGKILL');
    await exited;
  }
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function childEnvironment(inheritCredentials) {
  if (inheritCredentials) return process.env;
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key),
    ),
  );
}

function resolveCodexExecutable(configured) {
  if (configured !== 'codex' || process.platform !== 'darwin') return configured;
  for (const candidate of [
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next known local install location.
    }
  }
  return configured;
}

function appServerExitError(code, signal) {
  const outcome = code === null ? `signal ${String(signal)}` : `exit ${String(code)}`;
  return new Error(`Codex app-server exited (${outcome})`);
}

function formatRpcError(error) {
  const code = error && typeof error.code === 'number' ? ` ${error.code}` : '';
  const message = error && typeof error.message === 'string' ? error.message : 'unknown error';
  return `Codex app-server RPC${code}: ${message}`;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Codex app-server returned an invalid ${label}`);
  }
  return value;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isRecoverable(error) {
  return error?.code !== 'ENOENT';
}

const silentLogger = Object.freeze({
  warn() {},
});
