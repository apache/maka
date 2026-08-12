import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  HookCompletedAudit,
  HookConfigFile,
  HookSource,
  PreToolUseHookInput,
  ResolvedHookDefinition,
} from '@maka/core/hooks';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import {
  createPreToolUseHookDispatcher,
  type PreToolUseHookDispatcher,
} from '@maka/runtime/hooks/engine';
import {
  createHookConfigStore,
  createHookTrustStore,
  readHookConfigFile,
  type HookConfigStore,
  type HookTrustStore,
} from '@maka/storage';

interface HookRuntimeEventWriter {
  appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void>;
}

export interface HostHookComposition {
  dispatcherFor(header: SessionHeader): PreToolUseHookDispatcher;
}

export function createHostHookComposition(input: {
  stateRoot: string;
  runtimeEvents: HookRuntimeEventWriter;
}): HostHookComposition {
  const userConfig = createHookConfigStore(input.stateRoot);
  const trust = createHookTrustStore(input.stateRoot);
  return {
    dispatcherFor(header) {
      return createSessionHookDispatcher({
        header,
        userConfig,
        trust,
        runtimeEvents: input.runtimeEvents,
      });
    },
  };
}

function createSessionHookDispatcher(input: {
  header: SessionHeader;
  userConfig: HookConfigStore;
  trust: HookTrustStore;
  runtimeEvents: HookRuntimeEventWriter;
}): PreToolUseHookDispatcher {
  return createPreToolUseHookDispatcher({
    loadSnapshot: () => loadSnapshot(input),
    recordAudit: (hookInput, audit, context) =>
      recordAudit(input.runtimeEvents, hookInput, audit, context.invocationId),
  });
}

async function loadSnapshot(input: {
  header: SessionHeader;
  userConfig: HookConfigStore;
  trust: HookTrustStore;
}): Promise<ResolvedHookDefinition[]> {
  const projectIdentity = input.header.projectId
    ? `project:${input.header.projectId}`
    : `workspace:${input.header.workspaceRoot}`;
  const [userConfig, projectConfig, trust] = await Promise.all([
    input.userConfig.get(),
    readHookConfigFile(join(input.header.cwd, '.maka', 'hooks.json')),
    input.trust.get(),
  ]);
  const trustedHashes = new Set(trust.trustedDefinitions.map((record) => record.definitionHash));
  const definitions: ResolvedHookDefinition[] = [];
  appendDefinitions(definitions, userConfig, {
    source: 'user',
    sourceOrder: 0,
    projectIdentity: 'user',
    trustedHashes,
  });
  appendDefinitions(definitions, projectConfig, {
    source: 'project',
    sourceOrder: 1,
    projectIdentity,
    trustedHashes,
  });
  return definitions;
}

function appendDefinitions(
  output: ResolvedHookDefinition[],
  config: HookConfigFile,
  input: {
    source: HookSource;
    sourceOrder: number;
    projectIdentity: string;
    trustedHashes: ReadonlySet<string>;
  },
): void {
  for (const group of config.hooks.PreToolUse ?? []) {
    for (const handler of group.hooks) {
      if (handler.enabled === false) continue;
      const definitionOrder = output.length;
      const definitionHash = hashDefinition({
        source: input.source,
        projectIdentity: input.projectIdentity,
        matcher: group.matcher ?? '*',
        command: handler.command,
        args: handler.args ?? [],
        timeoutMs: handler.timeoutMs ?? 3_000,
      });
      output.push({
        id: handler.id,
        eventName: 'PreToolUse',
        matcher: group.matcher ?? '*',
        command: handler.command,
        args: handler.args ?? [],
        timeoutMs: handler.timeoutMs ?? 3_000,
        source: input.source,
        sourceOrder: input.sourceOrder,
        definitionOrder,
        projectIdentity: input.projectIdentity,
        definitionHash,
        trusted: input.trustedHashes.has(definitionHash),
      });
    }
  }
}

export function hashHookDefinition(input: {
  source: HookSource;
  projectIdentity: string;
  matcher: string;
  command: string;
  args: readonly string[];
  timeoutMs: number;
}): `sha256:${string}` {
  return hashDefinition(input);
}

function hashDefinition(input: {
  source: HookSource;
  projectIdentity: string;
  matcher: string;
  command: string;
  args: readonly string[];
  timeoutMs: number;
}): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        1,
        input.source,
        input.projectIdentity,
        'PreToolUse',
        input.matcher,
        'command',
        input.command,
        input.args,
        input.timeoutMs,
      ]),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

async function recordAudit(
  runtimeEvents: HookRuntimeEventWriter,
  input: PreToolUseHookInput,
  audit: HookCompletedAudit,
  invocationId: string,
): Promise<void> {
  await runtimeEvents.appendRuntimeEvent(input.session_id, input.run_id, {
    id: randomUUID(),
    invocationId,
    runId: input.run_id,
    sessionId: input.session_id,
    turnId: input.turn_id,
    ts: Date.now(),
    partial: false,
    role: 'system',
    author: 'host',
    origin: input.origin,
    modelVisibility: 'hidden',
    actions: { hookCompleted: audit },
    refs: { toolCallId: input.tool_use_id },
  });
}
