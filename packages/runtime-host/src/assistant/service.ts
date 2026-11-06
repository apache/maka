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

import type { createAssistantPetPacks } from '../server/assistant-pet-packs.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { TurnOrigin } from '@maka/core/turn-origin';
import type { MessageContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { AssistantBotBridge } from './bot/bridge.js';
import { BOT_TOOLS, BOT_DELEGATION_TOOLS } from './bot/capabilities.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  MEMORY_EXTRACT_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
} from '@maka/runtime/memory-extraction';
import type { PluginAgentService } from '@maka/runtime/plugin-agent-service';
import type { PluginLlmService } from '@maka/runtime/plugin-llm-service';
import type { PluginSessionQueryService } from '@maka/runtime/plugin-session-query-service';
import type { PluginSourceService } from '@maka/runtime/plugin-source-service';
import type {
  PluginSystemPromptContext,
  PluginSystemPromptSection,
} from '@maka/runtime/plugin-system-prompt-service';
import type {
  TurnFinishCheck,
  TurnFinishContext,
  TurnFinishDecision,
} from '@maka/runtime/plugin-turn-finish-service';
import type { HostPluginDataRuntime } from '../server/plugin-data-runtime.js';
import type { MakaCompositionEntryInspection } from '@maka/runtime/plugin-runtime';
import { RunCostLedger, type ReadSessionUsage } from './run-cost.js';

export const ASSISTANT_LEGACY_PACKAGES = [
  'dev.maka.memory-network',
  'dev.maka.proactive-matters',
  'dev.maka.index-initiative',
] as const;
type Component = 'memory-network' | 'proactive-matters' | 'index-initiative';
type Settings = Record<Component, { directory: string; config: Record<string, any> }>;
type Dispose = () => void | Promise<void>;

/** Shared Host capabilities retain invocation identity and source permissions. No plugin Fiber owns this service. */
export interface AssistantDependencies {
  petPacks?: ReturnType<typeof createAssistantPetPacks>;
  allocateWorkspace?(): Promise<{ projectId: string }>;
  readRuntimeEvents?(sessionId: string, runId?: string): Promise<readonly RuntimeEvent[]>;
  /** Cheap durable checkpoint identity; used only to refresh the Bot's optional sticker shelf. */
  readCompactionRevision?(sessionId: string): Promise<string | undefined>;
  publishCharacterImage?(
    sessionId: string,
    assetId: string,
    image: { bytes: Uint8Array; mimeType: string },
    kind: 'image' | 'avatar' | 'sticker',
  ): Promise<string>;
  agents: PluginAgentService;
  llm: PluginLlmService;
  sessionQuery: PluginSessionQueryService;
  sources: PluginSourceService;
  readAvatarImage?(
    sessionId: string,
    source: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
  appendConversation?(sessionId: string, message: StoredMessage): Promise<void>;
  /** Reconcile the selected model before admitting a new Bot wake. */
  prepareBotWake(ownerId: string, workerId: string): Promise<'ready' | 'deferred'>;
  stopSessions(): Promise<void>;
  markBackgroundSessions(sessionIds: readonly string[]): Promise<void>;
  resolveTools(sessionId: string, core: readonly MakaTool[]): { tools: readonly MakaTool[] };
  /**
   * Model usage a Session accrued in a time window, read from the Usage ledger.
   * Observability only (#6309): without it runs are still counted, but their
   * cost is recorded as unknown.
   */
  readSessionUsage?: ReadSessionUsage;
}

export interface AssistantModuleServices
  extends Omit<AssistantDependencies, 'resolveTools' | 'stopSessions' | 'readSessionUsage'> {
  bot: AssistantBotBridge;
  /** Cost and outcome of discovery runs and Matter activations; never limits them (#6309). */
  runCost: RunCostLedger;
  backgroundSessions: { register(read: () => readonly string[]): void };
  onClose(dispose: Dispose): void;
  onStart(start: () => Dispose): void;
  tools: {
    register(tool: MakaTool): void;
    registerSessionAccess?(allows: (sessionId: string) => boolean): void;
    filter?(filter: (sessionId: string, tools: readonly MakaTool[]) => readonly MakaTool[]): void;
    resolve(sessionId?: string, core?: readonly MakaTool[]): { tools: readonly MakaTool[] };
  };
  systemPrompt: {
    section(value: PluginSystemPromptSection): void;
    context(value: PluginSystemPromptSection): void;
  };
  turns: { beforeFinish(value: TurnFinishCheck): void };
  api: { register(name: string, invoke: (input: any) => any): void };
}

class AssistantRuntime {
  readonly tools: MakaTool[] = [];
  private readonly internalTools: MakaTool[] = [];
  readonly toolFilters: ((sessionId: string, tools: readonly MakaTool[]) => readonly MakaTool[])[] =
    [];
  readonly bot = new AssistantBotBridge();
  private readonly backgroundSessions: (() => readonly string[])[] = [];
  private readonly sessionAccess: ((sessionId: string) => boolean)[] = [];
  hasSessionAccess(sessionId: string) {
    return (
      this.bot.isConversation(sessionId) ||
      this.bot.isWorker(sessionId) ||
      this.backgroundSessions.some((read) => read().includes(sessionId)) ||
      this.sessionAccess.some((allows) => allows(sessionId))
    );
  }
  /**
   * The only visibility policy. Catalogs and execution both use it, so a tool hidden
   * from a Session cannot run in that Session either.
   */
  visibleTools(sessionId: string, tools: readonly MakaTool[]): readonly MakaTool[] {
    const nativeNames = new Set(this.tools.map((tool) => tool.name));
    const allowed = this.hasSessionAccess(sessionId)
      ? tools
      : tools.filter((tool) => !nativeNames.has(tool.name));
    return this.toolFilters.reduce((current, filter) => filter(sessionId, current), allowed);
  }
  private readonly sections: PluginSystemPromptSection[] = [];
  private readonly contexts: PluginSystemPromptSection[] = [];
  private readonly checks: TurnFinishCheck[] = [];
  private readonly calls = new Map<string, (input: any) => any>();
  private readonly starters: (() => Dispose)[] = [];
  private readonly stops: Dispose[] = [];
  private readonly disposers: Dispose[] = [];
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private initialized = false;
  private started = false;
  private draining = false;
  private closing = false;
  private shutdown?: Promise<void>;
  constructor(
    readonly directory: string,
    readonly dependencies: AssistantDependencies,
  ) {}

  async recover(legacy: HostPluginDataRuntime, entries: readonly MakaCompositionEntryInspection[]) {
    if (this.initialized) throw Error('Personal assistant already initialized');
    const settings = await this.loadSettings(legacy, entries);
    const runCost = new RunCostLedger(this.directory, this.dependencies.readSessionUsage);
    this.disposers.push(() => runCost.close());
    const services: AssistantModuleServices = {
      bot: this.bot,
      runCost,
      backgroundSessions: { register: (read) => this.backgroundSessions.push(read) },
      ...this.dependencies,
      onClose: (dispose: Dispose) => this.disposers.push(dispose),
      onStart: (start: () => Dispose) => this.starters.push(start),
      tools: {
        filter: (filter) => this.toolFilters.push(filter),
        registerSessionAccess: (allows) => this.sessionAccess.push(allows),
        register: (tool: MakaTool) => {
          if (this.tools.some((t) => t.name === tool.name))
            throw Error(`Duplicate assistant tool: ${tool.name}`);
          const internalTool: MakaTool = {
            ...tool,
            impl: (input, call) => {
              if (this.closing) throw Error('Personal assistant is shutting down');
              const scoped = {
                ...call,
                ...(BOT_DELEGATION_TOOLS.has(tool.name) && this.bot.ownerFor(call.sessionId)
                  ? { sessionId: this.bot.ownerFor(call.sessionId)! }
                  : {}),
                abortSignal: AbortSignal.any([
                  this.abort.signal,
                  ...(call.abortSignal ? [call.abortSignal] : []),
                ]),
              };
              return this.track(() => {
                scoped.abortSignal.throwIfAborted();
                return this.dependencies.agents.withInvocation(scoped, () =>
                  tool.impl(input, scoped),
                );
              });
            },
          };
          this.internalTools.push(internalTool);
          this.tools.push({
            ...internalTool,
            impl: (input, call) => {
              if (this.closing) throw Error('Personal assistant is shutting down');
              if (!this.hasSessionAccess(call.sessionId))
                throw Error('Personal assistant tools are unavailable in this session');
              if (!this.visibleTools(call.sessionId, [tool]).length)
                throw Error('Personal assistant tool is unavailable in this session');
              return internalTool.impl(input, call);
            },
          });
        },
        // Only Host module APIs use this resolver. They retain the caller's source
        // permissions (e.g. ordinary-chat original links) without exposing model tools.
        resolve: (sessionId?: string) =>
          sessionId
            ? this.dependencies.resolveTools(sessionId, this.internalTools)
            : { tools: this.internalTools },
      },
      systemPrompt: {
        section: (value: PluginSystemPromptSection) => this.sections.push(value),
        context: (value: PluginSystemPromptSection) => this.contexts.push(value),
      },
      turns: { beforeFinish: (value: TurnFinishCheck) => this.checks.push(value) },
      api: {
        register: (name: string, invoke: (input: any) => any) => {
          if (this.calls.has(name)) throw Error(`Duplicate assistant method: ${name}`);
          this.calls.set(name, invoke);
        },
      },
    };
    try {
      const [{ initializeMemory }, { initializeMatters }, { initializeInitiative }] =
        await Promise.all([
          import('./memory-network/host.js'),
          import('./proactive-matters/host.js'),
          import('./index-initiative/host.js'),
        ]);
      for (const [name, initialize] of [
        ['memory-network', initializeMemory],
        ['proactive-matters', initializeMatters],
        ['index-initiative', initializeInitiative],
      ] as const)
        await initialize(services, settings[name].directory, settings[name].config);
      await this.dependencies.markBackgroundSessions([
        ...new Set(this.backgroundSessions.flatMap((read) => read())),
      ]);
      this.initialized = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  start() {
    if (this.draining) return;
    if (!this.initialized) throw Error('Personal assistant is not ready');
    if (this.started) return;
    this.started = true;
    for (const start of this.starters) this.stops.push(start());
  }
  async call(method: string, input: unknown): Promise<unknown> {
    if (!this.started || this.draining) throw Error('Personal assistant is not ready');
    const invoke = this.calls.get(method);
    if (!invoke) throw Error('Unknown personal assistant operation');
    return this.track(async () => JSON.parse(JSON.stringify(await invoke(input))));
  }
  async prompt(context: PluginSystemPromptContext, baseText?: string) {
    const resolve = async (items: PluginSystemPromptSection[]) => {
      const result: { name: string; text: string }[] = [];
      for (const item of [...items].sort((a, b) => a.order - b.order)) {
        const text = typeof item.text === 'function' ? await item.text(context) : item.text;
        if (text) result.push({ name: item.name, text });
      }
      return result;
    };
    if (this.closing) return { text: baseText, contexts: [], sourceRevision: undefined };
    return this.track(async () => {
      const nativeSections = await resolve(this.sections);
      const contexts = await resolve(this.contexts);
      if (this.closing) return { text: baseText, contexts: [], sourceRevision: undefined };
      return {
        text:
          [baseText, ...nativeSections.map((x) => x.text)].filter(Boolean).join('\n\n') ||
          undefined,
        contexts,
        sourceRevision: {
          id: 'host.personal-assistant',
          revision:
            'sha256:' +
            createHash('sha256')
              .update(JSON.stringify({ sections: nativeSections, contexts }))
              .digest('hex'),
        },
      };
    });
  }
  async beforeFinish(context: TurnFinishContext): Promise<TurnFinishDecision> {
    if (this.closing) return { allow: true };
    return this.track(async () => {
      for (const check of this.checks) {
        if (this.closing) break;
        const result = await check.check(context);
        if (!result.allow && !this.closing) return result;
      }
      return { allow: true };
    });
  }
  beginDrain() {
    this.draining = true;
  }
  private track<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(operation);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  close(): Promise<void> {
    this.closing = true;
    this.abort.abort(Error('Personal assistant disabled'));
    this.beginDrain();
    return (this.shutdown ??= (async () => {
      const failures: unknown[] = [];
      try {
        await this.dependencies.stopSessions();
      } catch (error) {
        failures.push(error);
      }
      // Stop admission and schedulers before closing stores used by in-flight tools.
      for (const dispose of [...this.stops].reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.allSettled([...this.pending]);
      // Also stop foreground assistant turns and any worker admitted while stopping.
      try {
        await this.dependencies.stopSessions();
      } catch (error) {
        failures.push(error);
      }
      for (const dispose of [...this.disposers].reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Personal assistant shutdown failed');
    })());
  }
  private async loadSettings(
    legacy: HostPluginDataRuntime,
    entries: readonly MakaCompositionEntryInspection[],
  ): Promise<Settings> {
    const path = join(this.directory, 'assistant.json');
    try {
      const settings = JSON.parse(await readFile(path, 'utf8'));
      for (const name of ['memory-network', 'proactive-matters', 'index-initiative']) {
        if (
          !settings[name] ||
          !isAbsolute(settings[name].directory) ||
          !settings[name].config ||
          typeof settings[name].config !== 'object'
        )
          throw Error('Invalid personal assistant settings; existing data was not changed');
      }
      return settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const all = (
      items: readonly MakaCompositionEntryInspection[],
    ): MakaCompositionEntryInspection[] => items.flatMap((e) => [e, ...all(e.children)]);
    const settings = {} as Settings;
    for (const id of ASSISTANT_LEGACY_PACKAGES) {
      const name = id.slice('dev.maka.'.length) as Component;
      const matches = all(entries).filter((e) => e.packageId === id && e.rootId === 'profile');
      if (matches.length > 1)
        throw Error(`Multiple legacy configurations for ${id}; cannot choose a data authority`);
      const config: Record<string, any> = matches[0]?.config ?? {};
      const old = await legacy.read(
        { extensionId: id, scopeId: 'profile' },
        'storage',
        'data-directory',
      );
      const directory = old.value ?? config.dataDirectory ?? join(this.directory, name);
      if (typeof directory !== 'string' || !isAbsolute(directory))
        throw Error(`Invalid existing data directory: ${id}`);
      settings[name] = { directory, config };
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    return settings;
  }
}

/** Host-owned enablement, on by default. Disabled Hosts do not load modules, open their databases or start timers. */
export class PersonalAssistantService {
  private runtime?: AssistantRuntime;
  private legacy?: HostPluginDataRuntime;
  private entries: readonly MakaCompositionEntryInspection[] = [];
  private started = false;
  private draining = false;
  private recovered = false;
  private transition: Promise<unknown> = Promise.resolve();
  private shutdown?: Promise<void>;
  private stoppingError?: unknown;
  private initializationError?: string;
  constructor(
    readonly directory: string,
    readonly dependencies: AssistantDependencies,
  ) {}

  get enabled() {
    return !!this.runtime && !this.draining;
  }
  get tools(): readonly MakaTool[] {
    return this.enabled ? this.runtime!.tools : [];
  }

  async recover(legacy: HostPluginDataRuntime, entries: readonly MakaCompositionEntryInspection[]) {
    if (this.recovered) throw Error('Personal assistant already initialized');
    this.legacy = legacy;
    this.entries = entries;
    try {
      let enabled = true;
      try {
        const saved = JSON.parse(await readFile(join(this.directory, 'enablement.json'), 'utf8'));
        if (typeof saved.enabled !== 'boolean')
          throw Error('Invalid personal assistant enablement');
        enabled = saved.enabled;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (enabled) this.runtime = await this.initialize();
    } catch (error) {
      // Optional assistant recovery must not prevent ordinary Host sessions from starting.
      // Keep persisted preferences/data intact so Settings can retry after repair.
      this.initializationError = error instanceof Error ? error.message : String(error);
    }
    this.recovered = true;
  }
  private async initialize() {
    const runtime = new AssistantRuntime(this.directory, this.dependencies);
    try {
      await runtime.recover(this.legacy!, this.entries);
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  start() {
    if (this.draining) return;
    if (!this.recovered) throw Error('Personal assistant is not ready');
    this.started = true;
    this.runtime?.start();
  }
  private async persist(enabled: boolean) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'enablement.json');
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ enabled }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  }
  async call(method: string, input: unknown): Promise<unknown> {
    if (!this.started || this.draining) throw Error('Personal assistant is not ready');
    if (method === 'assistant.enablement')
      return {
        enabled: this.enabled,
        ...(this.initializationError ? { error: this.initializationError } : {}),
      };
    if (method === 'assistant.set-enabled') {
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).length !== 1 ||
        typeof (input as { enabled?: unknown }).enabled !== 'boolean'
      )
        throw Error('Expected { enabled: boolean }');
      const enabled = (input as { enabled: boolean }).enabled;
      const change = this.transition.then(async () => {
        if (this.draining) throw Error('Personal assistant is not ready');
        if (this.stoppingError)
          throw Error('Personal assistant did not stop cleanly; restart Host before enabling', {
            cause: this.stoppingError,
          });
        if (enabled === this.enabled) return { enabled };
        if (enabled) {
          const runtime = await this.initialize();
          try {
            if (this.draining) throw Error('Personal assistant is shutting down');
            await this.persist(true);
            if (this.draining) throw Error('Personal assistant is shutting down');
            this.runtime = runtime;
            runtime.start();
            this.initializationError = undefined;
          } catch (error) {
            this.runtime = undefined;
            await this.persist(false);
            await runtime.close();
            throw error;
          }
        } else {
          await this.persist(false);
          const runtime = this.runtime!;
          this.runtime = undefined;
          try {
            await runtime.close();
          } catch (error) {
            this.stoppingError = error;
            throw error;
          }
        }
        return { enabled: this.enabled };
      });
      this.transition = change.catch(() => {});
      return change;
    }
    if (!this.enabled) throw Error('Personal assistant is disabled; enable it in Settings');
    return this.runtime!.call(method, input);
  }
  async prompt(context: PluginSystemPromptContext, baseText?: string) {
    return this.enabled
      ? this.runtime!.prompt(context, baseText)
      : { text: baseText, contexts: [], sourceRevision: undefined };
  }
  isConversation(sessionId: string) {
    return this.enabled && this.runtime!.bot.isConversation(sessionId);
  }
  hasInboxMessage(sessionId: string, id: string) {
    return this.enabled && this.runtime!.bot.hasUserMessage(sessionId, id);
  }
  filterTools(sessionId: string, tools: readonly MakaTool[]): readonly MakaTool[] {
    if (!this.enabled) return tools;
    return this.runtime!.visibleTools(sessionId, tools);
  }
  /** AiSdkBackend appends its untyped memory triggers after tool resolution, so they pass the same session filter here. */
  admitsMemoryTriggers(sessionId: string): boolean {
    const triggers = [MEMORY_REMEMBER_TOOL_NAME, MEMORY_EXTRACT_TOOL_NAME].map(
      (name) => ({ name }) as MakaTool,
    );
    return this.filterTools(sessionId, triggers).length === triggers.length;
  }
  toolCeiling(sessionId: string): readonly MakaTool[] | undefined {
    return this.enabled && this.runtime!.bot.isWorker(sessionId)
      ? this.runtime!.tools.filter((tool) => BOT_TOOLS.has(tool.name))
      : undefined;
  }
  async receiveUser(
    sessionId: string,
    id: string,
    content: MessageContent,
    origin?: Extract<TurnOrigin, { kind: 'external_connector' }>,
  ) {
    if (!this.enabled || this.draining) return false;
    return this.runtime!.bot.receive(sessionId, id, content, origin);
  }
  async beforeFinish(context: TurnFinishContext): Promise<TurnFinishDecision> {
    return this.enabled ? this.runtime!.beforeFinish(context) : { allow: true };
  }
  beginDrain() {
    this.draining = true;
    this.runtime?.beginDrain();
  }
  close(): Promise<void> {
    this.beginDrain();
    return (this.shutdown ??= (async () => {
      await this.transition;
      const runtime = this.runtime;
      this.runtime = undefined;
      await runtime?.close();
    })());
  }
}
