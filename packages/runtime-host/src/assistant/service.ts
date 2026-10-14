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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MakaTool } from '@maka/runtime/tool-runtime';
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
import { initializeMemory } from './memory-network/host.js';
import { initializeMatters } from './proactive-matters/host.js';
import { initializeInitiative } from './index-initiative/host.js';

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
  agents: PluginAgentService;
  llm: PluginLlmService;
  sessionQuery: PluginSessionQueryService;
  sources: PluginSourceService;
  markBackgroundSessions(sessionIds: readonly string[]): Promise<void>;
  resolveTools(sessionId: string, core: readonly MakaTool[]): { tools: readonly MakaTool[] };
}

export interface AssistantModuleServices extends Omit<AssistantDependencies, 'resolveTools'> {
  backgroundSessions: { register(read: () => readonly string[]): void };
  onClose(dispose: Dispose): void;
  onStart(start: () => Dispose): void;
  tools: {
    register(tool: MakaTool): void;
    resolve(sessionId?: string, core?: readonly MakaTool[]): { tools: readonly MakaTool[] };
  };
  systemPrompt: {
    section(value: PluginSystemPromptSection): void;
    context(value: PluginSystemPromptSection): void;
  };
  turns: { beforeFinish(value: TurnFinishCheck): void };
  api: { register(name: string, invoke: (input: any) => any): void };
}

export class PersonalAssistantService {
  readonly tools: MakaTool[] = [];
  private readonly sections: PluginSystemPromptSection[] = [];
  private readonly contexts: PluginSystemPromptSection[] = [];
  private readonly checks: TurnFinishCheck[] = [];
  private readonly calls = new Map<string, (input: any) => any>();
  private readonly starters: (() => Dispose)[] = [];
  private readonly stops: Dispose[] = [];
  private readonly disposers: Dispose[] = [];
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
    const backgroundSessions: (() => readonly string[])[] = [];
    const services: AssistantModuleServices = {
      backgroundSessions: { register: (read) => backgroundSessions.push(read) },
      ...this.dependencies,
      onClose: (dispose: Dispose) => this.disposers.push(dispose),
      onStart: (start: () => Dispose) => this.starters.push(start),
      tools: {
        register: (tool: MakaTool) => {
          if (this.tools.some((t) => t.name === tool.name))
            throw Error(`Duplicate assistant tool: ${tool.name}`);
          this.tools.push({
            ...tool,
            impl: (input, call) => {
              if (this.closing) throw Error('Personal assistant is shutting down');
              return this.dependencies.agents.withInvocation(call, () => tool.impl(input, call));
            },
          });
        },
        resolve: (sessionId?: string) =>
          sessionId ? this.dependencies.resolveTools(sessionId, this.tools) : { tools: this.tools },
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
      for (const [name, initialize] of [
        ['memory-network', initializeMemory],
        ['proactive-matters', initializeMatters],
        ['index-initiative', initializeInitiative],
      ] as const)
        await initialize(services, settings[name].directory, settings[name].config);
      await this.dependencies.markBackgroundSessions([
        ...new Set(backgroundSessions.flatMap((read) => read())),
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
    return JSON.parse(JSON.stringify(await invoke(input)));
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
    const nativeSections = await resolve(this.sections);
    const contexts = await resolve(this.contexts);
    return {
      text:
        [baseText, ...nativeSections.map((x) => x.text)].filter(Boolean).join('\n\n') || undefined,
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
  }
  async beforeFinish(context: TurnFinishContext): Promise<TurnFinishDecision> {
    for (const check of this.checks) {
      const result = await check.check(context);
      if (!result.allow) return result;
    }
    return { allow: true };
  }
  beginDrain() {
    this.draining = true;
  }
  close(): Promise<void> {
    this.closing = true;
    this.beginDrain();
    return (this.shutdown ??= (async () => {
      const failures: unknown[] = [];
      for (const dispose of [...this.stops.reverse(), ...this.disposers.reverse()]) {
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
