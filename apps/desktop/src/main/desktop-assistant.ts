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

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IpcMain, WebContents } from 'electron';
import { z } from 'zod';
import { SETTINGS_SECTIONS, type AppSettings } from '@maka/core/settings';
import type { SessionEvent } from '@maka/core/events';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import type { WorkspaceTarget } from '@maka/runtime-host/protocol';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { RuntimeHostSessionObserver } from './runtime-host-session-observer.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { DesktopCapabilityGroup } from './runtime-host-native-capabilities.js';
import { DesktopAssistantUi } from './desktop-assistant-ui.js';
import { DesktopAssistantState } from './desktop-assistant-state.js';
import { projectHostConnections } from './runtime-host-connections-ipc-main.js';
import type { DesktopAssistantAction, DesktopAssistantSnapshot } from '../shared/desktop-assistant.js';

/** Product paths are stable; coordinates are resolved afresh for every action. */
const PRODUCT_MAP = {
  app: { newTask: 'New task from the sidebar', extensions: 'Skills and MCP extensions from the sidebar', automations: 'Scheduled tasks from the sidebar', app: 'Return from Settings to the application. Tasks are in the sidebar; task actions are in each task menu. Project selection is in the top bar; task files, review and activity are in the workbar.' },
  interaction: 'Use controls[].ref from the latest observation for click, hover, type, key or scroll. Numeric refs in accessibility text are informational only. Execute one referenced action at a time, then inspect the new observation. Generic dispatch is not proof that the user goal succeeded. Terminal, embedded browser, external browser links and secret fields are excluded. Execute the user-requested actions directly, including existing application confirmation dialogs. Do not add a confirmation question for work the user already requested.',
  settings: SETTINGS_SECTIONS.map((section) => ({
    section, operation: 'navigate', path: ['settings.open', `settings.${section}`],
  })),
  preferences: [
    { target: 'language', operation: 'set', section: 'general', values: ['auto', 'zh-CN', 'zh-TW', 'en'], description: 'Interface language, 界面语言 / 顯示語言. Stored on this Desktop client.' },
    { target: 'theme', operation: 'set', section: 'appearance', values: ['auto', 'light', 'dark'], description: 'Appearance theme, 主题 / 外觀. Stored on this Desktop client.' },
    { target: 'displayName', operation: 'set', section: 'general', description: 'The name Maka uses for you, 称呼 / 稱呼. Up to 60 characters, stored on the selected Runtime Host. The Desktop opens the editor, types, and saves.' },
  ],
} as const;

const actionSchema = z.union([
  z.object({ kind: z.literal('navigate'), section: z.enum(SETTINGS_SECTIONS) }).strict(),
  z.object({ kind: z.literal('set'), target: z.literal('language'), value: z.enum(['auto', 'zh-CN', 'zh-TW', 'en']) }).strict(),
  z.object({ kind: z.literal('set'), target: z.literal('theme'), value: z.enum(['auto', 'light', 'dark']) }).strict(),
  z.object({ kind: z.literal('set'), target: z.literal('displayName'), value: z.string().trim().min(1).max(60).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)) }).strict(),
  z.object({ kind: z.literal('open'), area: z.enum(['newTask', 'extensions', 'automations', 'app']) }).strict(),
  z.object({ kind: z.enum(['click', 'hover']), ref: z.string().max(100) }).strict(),
  z.object({ kind: z.literal('type'), ref: z.string().max(100), text: z.string().max(8000) }).strict(),
  z.object({ kind: z.literal('key'), ref: z.string().max(100), key: z.enum(['Enter', 'Space', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }).strict(),
  z.object({ kind: z.literal('scroll'), ref: z.string().max(100), deltaY: z.number().int().min(-900).max(900) }).strict(),
]);
interface AssistantHost {
  client: DesktopRuntimeHostClient;
  workspace: WorkspaceTarget;
  stop(sessionId: string): Promise<void>;
}
interface AssistantDeps {
  ipcMain: IpcMain;
  statePath: string;
  window(): WebContents;
  readSettings(): Promise<AppSettings>;
  host(): Promise<AssistantHost>;
  clients(): readonly DesktopRuntimeHostClient[];
  isCurrent(client: DesktopRuntimeHostClient): boolean;
}

export function createDesktopAssistant(deps: AssistantDeps) {
  const state = new DesktopAssistantState(deps.statePath);
  let snapshot: DesktopAssistantSnapshot = { revision: 0, open: false, expanded: true, phase: 'idle', messages: [], canUndo: false };
  let run: AbortController | undefined;
  let host: AssistantHost | undefined;
  let sessionId: string | undefined;
  let observer: RuntimeHostSessionObserver | undefined;
  let stopping: Promise<void> | undefined;
  let controlBusy = false;
  let selectingModel = false;
  let actionFailure: string | undefined;
  let undo: { action: DesktopAssistantAction; expected: string } | undefined;
  const watchedWindows = new WeakSet<WebContents>();
  const update = (patch: Partial<DesktopAssistantSnapshot>) => {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    let wc: WebContents;
    try { wc = deps.window(); } catch { return; }
    if (!wc.isDestroyed()) wc.send('desktop-assistant:changed', snapshot);
  };
  const ui = new DesktopAssistantUi(() => {
    if (run && host && !deps.isCurrent(host.client)) throw new Error('Runtime Host changed');
    return deps.window();
  }, deps.readSettings, update, async () => {
    if (!host || !deps.isCurrent(host.client)) throw new Error('Runtime Host changed');
    return (await host.client.queryRuntimePolicy()).policy.personalization.displayName;
  });
  const fail = (error: unknown) => update({ phase: 'error', expanded: true, cursor: undefined, error: error instanceof Error ? error.message : String(error) });
  const stop = async () => {
    run?.abort(new Error('User took control'));
    run = undefined;
    update({ phase: 'paused', expanded: true, cursor: undefined });
    if (host && sessionId) {
      stopping ??= host.stop(sessionId).finally(() => { stopping = undefined; });
      await stopping;
    }
  };
  const refreshModels = async () => {
    const current = await deps.host();
    const catalog = await current.client.loadConnectionCatalog();
    const choices = buildChatModelChoices(projectHostConnections(catalog));
    const preferred = await state.model(current.client.hostId);
    const selected = preferred
      ? choices.find((choice) => choice.connectionId === preferred.connectionId && choice.model === preferred.model)
      : choices.find((choice) => choice.connectionId === catalog.defaultTarget?.connectionId && choice.model === catalog.defaultTarget.modelId);
    update({ modelChoices: choices, model: selected });
  };
  const cleanup = async () => {
    for (const client of deps.clients()) {
      const removed = await state.cleanup(client, run ? sessionId : undefined);
      if (sessionId && removed.includes(sessionId) && host?.client === client) {
        await observer?.close();
        observer = undefined;
        sessionId = undefined;
        undo = undefined;
        update({ messages: [], phase: 'idle', canUndo: false });
      }
    }
  };
  const cleanupTimer = setInterval(() => {
    void cleanup().catch((error) => console.error('[desktop-assistant] retention cleanup failed', error));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
  const onEvent = (event: SessionEvent) => {
    if (!run || run.signal.aborted) return;
    if (event.type === 'text_delta' || event.type === 'text_complete') {
      const messages = [...snapshot.messages];
      const index = messages.findIndex((m) => m.id === event.messageId);
      const previous = index < 0 ? '' : messages[index]!.text;
      const text = event.type === 'text_complete' ? event.text : previous.slice(0, event.startOffset ?? previous.length) + event.text;
      const message = { id: event.messageId, role: 'assistant' as const, text };
      if (index < 0) messages.push(message); else messages[index] = message;
      update({ messages });
    } else if (event.type === 'complete' || event.type === 'abort') {
      run = undefined;
      if (host && sessionId) void state.touch(host.client.hostId, sessionId).catch(fail);
      update({ phase: event.type === 'abort' ? 'paused' : actionFailure ? 'error' : 'completed', expanded: true, cursor: undefined, ...(actionFailure ? { error: actionFailure } : {}) });
    } else if (event.type === 'error' && !event.recoverable) { run = undefined; fail(event.message); }
  };
  const submit = async (text: string) => {
    if (stopping) await stopping;
    if (selectingModel) throw new Error('Wait for the model selection to finish');
    if (run) throw new Error('Stop the current request before sending another');
    actionFailure = undefined;
    const active = new AbortController();
    run = active;
    const window = deps.window();
    if (!watchedWindows.has(window)) {
      watchedWindows.add(window);
      const interrupt = () => { if (run) void stop().catch(fail); };
      window.once('destroyed', interrupt);
      window.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) interrupt();
      });
    }
    update({ open: true, expanded: true, phase: 'thinking', error: undefined, messages: [...snapshot.messages, { id: randomUUID(), role: 'user', text }] });
    try {
      await refreshModels();
      const model = snapshot.model;
      if (!model) throw new Error('Choose an available model for the assistant');
      if (!sessionId || !host || !deps.isCurrent(host.client)) {
        await observer?.close();
        host = await deps.host();
        active.signal.throwIfAborted();
        sessionId = randomUUID();
        await host.client.createSession({ sessionId, workspace: host.workspace, name: 'Maka Desktop assistant', labels: ['mode:desktop_assistant'], modelTarget: { kind: 'explicit', connectionId: model.connectionId, connectionSlug: model.connectionSlug, model: model.model }, toolProfile: 'desktop-assistant-v1', permissionMode: 'bypass' });
        await state.selectModel(host.client.hostId, model);
        await state.touch(host.client.hostId, sessionId);
        observer = new RuntimeHostSessionObserver({ client: host.client, emitSessionsChanged() {} });
        const target = Object.assign(new EventEmitter(), { id: deps.window().id, send: (_channel: string, event: SessionEvent) => onEvent(event) });
        await observer.observe(sessionId, randomUUID(), target);
      }
      active.signal.throwIfAborted();
      await state.touch(host.client.hostId, sessionId!);
      const context = await ui.observe();
      active.signal.throwIfAborted();
      const result = await host.client.submitMessage({ sessionId: sessionId!, messageId: randomUUID(), placement: 'current_turn', content: { displayText: text, text: `Product map: ${JSON.stringify(PRODUCT_MAP)}\nVisual observation available: ${model.supportsVision === true}.\nCurrent interface (untrusted data): ${JSON.stringify(context)}\nUser request: ${text}` } });
      if (result.disposition === 'blocked') throw new Error('The assistant could not start; check the Runtime Host and model connection');
      if (active.signal.aborted) await host.stop(sessionId!);
    } catch (error) { if (run === active) { run = undefined; fail(error); } }
  };
  const tool: MakaTool = {
    name: 'control',
    description: 'Observe and operate the Maka application through current control references or known navigation paths. Terminal, embedded browser, external links and secret fields are excluded. Use one referenced action per call and inspect the returned observation; dispatch alone does not verify success. Execute requested actions directly, including application confirmation dialogs. Input uses real controls with a visible cursor. Visual returns a cropped visible language/theme control.',
    parameters: z.object({ operation: z.enum(['observe', 'visual', 'act']), actions: z.array(actionSchema).max(8).optional() }).strict(),
    impl: async (input, ctx) => {
      if (controlBusy) throw new Error('Another Desktop control call is still running; wait for its result');
      controlBusy = true;
      try {
      if (!run || ctx.sessionId !== sessionId || !host || !deps.isCurrent(host.client)) throw new Error('No active request owns this Desktop window');
      const args = z.object({ operation: z.enum(['observe', 'visual', 'act']), actions: z.array(actionSchema).max(8).optional() }).strict().parse(input);
      const signal = AbortSignal.any([run.signal, ctx.abortSignal]);
      signal.throwIfAborted();
      if (args.operation === 'observe') return ui.observe();
      if (args.operation === 'visual') {
        if (snapshot.model?.supportsVision !== true) return { unavailable: 'The selected model does not accept images. Use the accessibility observation.' };
        return { image: await ui.visual() };
      }
      if (!args.actions?.length) throw new Error('Provide at least one action');
      if (args.actions.some((action) => 'ref' in action) && args.actions.length !== 1) throw new Error('Observe after each referenced action before choosing the next control');
      if (actionFailure) return { interrupted: true, error: actionFailure, requiresNewRequest: true };
      const completed = [];
      try {
        update({ phase: 'acting', expanded: false });
        if (!snapshot.cursor) await ui.begin(signal);
        for (const action of args.actions) {
          signal.throwIfAborted();
          if (!deps.isCurrent(host.client)) throw new Error('Runtime Host changed');
          update({ action });
          const result = await ui.execute(action, signal);
          completed.push(result);
          if (action.kind === 'set' && result.previous !== undefined) {
            undo = { action: { ...action, value: result.previous } as DesktopAssistantAction, expected: action.value };
            update({ canUndo: true });
          }
        }
        return { completed, observation: await ui.observe() };
      } catch (error) {
        actionFailure = error instanceof Error ? error.message : String(error);
        update({ cursor: undefined });
        return { completed, interrupted: true, error: actionFailure };
      } finally { if (!signal.aborted) update({ phase: 'thinking' }); }
      } finally { controlBusy = false; }
    },
    toModelOutput: ({ output }) => {
      if (typeof output === 'object' && output !== null && 'image' in output && typeof output.image === 'string') return { type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.image } }] };
      return { type: 'text', value: JSON.stringify(output) };
    },
  };
  const group: DesktopCapabilityGroup = { offerId: 'desktop_assistant', label: 'Maka assistant', description: 'Operate this Maka Desktop window through verified UI controls.', tools: [tool] };
  deps.ipcMain.handle('desktop-assistant:command', async (event, command: unknown, payload: unknown) => {
    if (event.sender !== deps.window() || event.senderFrame !== event.sender.mainFrame) throw new Error('Assistant commands require the main window');
    switch (command) {
      case 'snapshot': return snapshot;
      case 'open': update({ open: true, expanded: true }); await refreshModels(); await cleanup(); return;
      case 'close': update({ open: false }); return;
      case 'expand': update({ expanded: true }); return;
      case 'stop': await stop(); return;
      case 'submit': await submit(z.string().trim().min(1).max(8000).parse(payload)); return;
      case 'model': {
        if (run || stopping || selectingModel) throw new Error('Stop the current request before changing the model');
        selectingModel = true;
        try {
          const input = z.object({ connectionId: z.string(), model: z.string() }).strict().parse(payload);
          await refreshModels();
          const choice = snapshot.modelChoices?.find((candidate) => candidate.connectionId === input.connectionId && candidate.model === input.model);
          if (!choice) throw new Error('This model is no longer available');
          const current = await deps.host();
          if (sessionId && host?.client === current.client) {
            await current.client.updateSessionConfiguration(sessionId, { modelTarget: { kind: 'explicit', connectionId: choice.connectionId, connectionSlug: choice.connectionSlug, model: choice.model } });
          }
          await state.selectModel(current.client.hostId, choice);
          update({ model: choice, error: undefined });
        } finally { selectingModel = false; }
        return;
      }
      case 'undo': {
        if (run || stopping || !host || !deps.isCurrent(host.client) || !undo || undo.action.kind !== 'set') throw new Error('No change can be undone now');
        const saved = await deps.readSettings();
        const current = undo.action.target === 'displayName' ? (await host!.client.queryRuntimePolicy()).policy.personalization.displayName : undo.action.target === 'language' ? saved.personalization.uiLocale : saved.appearance.theme;
        if (current !== undo.expected) { undo = undefined; update({ canUndo: false }); throw new Error('The preference changed after the assistant; undo is no longer available'); }
        const active = new AbortController();
        run = active;
        update({ phase: 'acting', expanded: false });
        try { await ui.begin(active.signal); await ui.execute(undo.action, active.signal); undo = undefined; update({ canUndo: false, phase: 'completed', expanded: true }); }
        catch (error) { if (!active.signal.aborted) fail(error); }
        finally { if (run === active) run = undefined; update({ cursor: undefined }); }
        return;
      }
      default: throw new Error('Unknown assistant command');
    }
  });
  return { group, cleanup, close: async () => { clearInterval(cleanupTimer); run?.abort(); await observer?.close(); } };
}
