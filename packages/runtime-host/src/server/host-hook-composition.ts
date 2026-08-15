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
  createHookExecutionLimiter,
  createPreToolUseHookDispatcher,
  type HookExecutionLimiter,
  type PreToolUseHookDispatcher,
  type ExtensionHookDispatchRuntimeContext,
  type ExtensionHookDispatchResult,
} from '@maka/runtime/hooks/engine';
import type {
  ExtensionHookContributionInspection,
  ExtensionHookEventName,
} from '@maka/runtime/extension-hook-contributions';
import {
  createHookConfigStore,
  createHookTrustStore,
  readHookConfigFile,
  type HookConfigStore,
  type HookTrustStore,
} from '@maka/storage';
import type { HostExtensionRuntime } from './extension-runtime.js';

interface HookRuntimeEventWriter {
  appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void>;
}

export interface HostHookComposition {
  dispatcherFor(header: SessionHeader): PreToolUseHookDispatcher;
}

export function createHostHookComposition(input: {
  stateRoot: string;
  runtimeEvents: HookRuntimeEventWriter;
  extensions?: HostExtensionRuntime;
}): HostHookComposition {
  const userConfig = createHookConfigStore(input.stateRoot);
  const trust = createHookTrustStore(input.stateRoot);
  const executionLimiter = createHookExecutionLimiter();
  return {
    dispatcherFor(header) {
      return createSessionHookDispatcher({
        header,
        userConfig,
        trust,
        executionLimiter,
        runtimeEvents: input.runtimeEvents,
        extensions: input.extensions,
      });
    },
  };
}

function createSessionHookDispatcher(input: {
  header: SessionHeader;
  userConfig: HookConfigStore;
  trust: HookTrustStore;
  executionLimiter: HookExecutionLimiter;
  runtimeEvents: HookRuntimeEventWriter;
  extensions?: HostExtensionRuntime;
}): PreToolUseHookDispatcher {
  const commandDispatcher = createPreToolUseHookDispatcher({
    loadSnapshot: () => loadSnapshot(input),
    executionLimiter: input.executionLimiter,
    recordAudit: (hookInput, audit, context) =>
      recordAudit(input.runtimeEvents, hookInput, audit, context.invocationId),
  });
  const extensionSnapshots = new Map<string, readonly ExtensionHookContributionInspection[]>();
  const snapshotFor = (turnId: string): readonly ExtensionHookContributionInspection[] => {
    let snapshot = extensionSnapshots.get(turnId);
    if (!snapshot) {
      snapshot = Object.freeze([...(input.extensions?.inspectHooks(input.header.id) ?? [])]);
      extensionSnapshots.set(turnId, snapshot);
    }
    return snapshot;
  };
  const runExtensionHook = (
    event: ExtensionHookEventName,
    payload: unknown,
    abortSignal: AbortSignal,
    context: ExtensionHookDispatchRuntimeContext,
  ) =>
    dispatchExtensionHooks({
      event,
      payload,
      abortSignal,
      context,
      hooks: snapshotFor(context.turnId),
      runtimeEvents: input.runtimeEvents,
      executionLimiter: input.executionLimiter,
    });
  return {
    prepareTurn(turnId) {
      commandDispatcher.prepareTurn(turnId);
      snapshotFor(turnId);
    },
    releaseTurn(turnId) {
      commandDispatcher.releaseTurn(turnId);
      extensionSnapshots.delete(turnId);
    },
    async runPreToolUse(hookInput, abortSignal, context) {
      const commandResult = await commandDispatcher.runPreToolUse(hookInput, abortSignal, context);
      if (commandResult.denied) return commandResult;
      const extensionResult = await runExtensionHook(
        'PreToolUse',
        {
          toolUseId: hookInput.tool_use_id,
          toolName: hookInput.tool_name,
          toolInput: hookInput.tool_input,
        },
        abortSignal,
        {
          ...context,
          sessionId: hookInput.session_id,
          runId: hookInput.run_id,
          turnId: hookInput.turn_id,
          cwd: hookInput.cwd,
          permissionMode: hookInput.permission_mode,
          origin: hookInput.origin,
        },
      );
      return {
        denied: extensionResult.denied,
        ...(extensionResult.reason ? { reason: extensionResult.reason } : {}),
        audits: [...commandResult.audits, ...extensionResult.audits],
        auditWriteFailures: [
          ...commandResult.auditWriteFailures,
          ...extensionResult.auditWriteFailures,
        ],
      };
    },
    runExtensionHook,
  };
}

async function dispatchExtensionHooks(input: {
  event: ExtensionHookEventName;
  payload: unknown;
  abortSignal: AbortSignal;
  context: ExtensionHookDispatchRuntimeContext;
  hooks: readonly ExtensionHookContributionInspection[];
  runtimeEvents: HookRuntimeEventWriter;
  executionLimiter: HookExecutionLimiter;
}): Promise<ExtensionHookDispatchResult> {
  let payload = structuredClone(input.payload);
  let denied = false;
  let reason: string | undefined;
  const audits: HookCompletedAudit[] = [];
  const auditWriteFailures: string[] = [];
  const candidates = input.hooks.filter(
    (hook) =>
      hook.event === input.event &&
      matcherMatches(hook.matcher, matcherSubject(input.event, payload)),
  );
  for (const hook of candidates) {
    if (input.abortSignal.aborted) {
      throw input.abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const startedAt = Date.now();
    let status: HookCompletedAudit['status'] = 'allowed';
    let message: string | undefined;
    try {
      const result = await input.executionLimiter.run(() =>
        hook.invoke(payload, {
          sessionId: input.context.sessionId,
          runId: input.context.runId,
          turnId: input.context.turnId,
          cwd: input.context.cwd,
          permissionMode: input.context.permissionMode,
          origin: input.context.origin,
          configuration: Object.freeze({}),
          signal: input.abortSignal,
        }),
      );
      if (hook.mode === 'gate' && result?.decision === 'deny') {
        denied = true;
        status = 'denied';
        reason = result.reason ?? `Hook ${hook.id} denied ${input.event}.`;
        message = reason;
      } else if (hook.mode === 'transform' && result && Object.hasOwn(result, 'payload')) {
        payload = mergeTransformPayload(payload, result.payload);
      }
    } catch (error) {
      if (input.abortSignal.aborted) throw error;
      status = 'failed';
      message = boundedMessage(error);
    }
    const audit: HookCompletedAudit = {
      eventName: input.event,
      handlerId: `${hook.extensionId}:${hook.id}`,
      definitionHash: extensionDefinitionHash(hook),
      source: 'extension',
      toolUseId: toolIdentity(payload, input.context.turnId),
      toolName: toolName(payload, input.event),
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(message ? { message } : {}),
    };
    audits.push(audit);
    try {
      await recordExtensionAudit(input.runtimeEvents, input.context, audit);
    } catch (error) {
      auditWriteFailures.push(boundedMessage(error));
    }
    if (denied) break;
  }
  return {
    denied,
    ...(reason ? { reason } : {}),
    payload,
    audits: Object.freeze(audits),
    auditWriteFailures: Object.freeze(auditWriteFailures),
  };
}

function mergeTransformPayload(current: unknown, replacement: unknown): unknown {
  if (
    current &&
    replacement &&
    typeof current === 'object' &&
    typeof replacement === 'object' &&
    !Array.isArray(current) &&
    !Array.isArray(replacement)
  ) {
    return structuredClone({
      ...(current as Record<string, unknown>),
      ...(replacement as Record<string, unknown>),
    });
  }
  return structuredClone(replacement);
}

function matcherSubject(event: ExtensionHookEventName, payload: unknown): string {
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return event;
  return toolName(payload, event);
}

function matcherMatches(matcher: string | undefined, subject: string): boolean {
  if (!matcher) return true;
  return matcher
    .split('|')
    .some((token) =>
      token === '*'
        ? true
        : token.endsWith('*')
          ? subject.startsWith(token.slice(0, -1))
          : token === subject,
    );
}

function toolIdentity(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'toolUseId' in payload) {
    const value = (payload as { toolUseId?: unknown }).toolUseId;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function toolName(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'toolName' in payload) {
    const value = (payload as { toolName?: unknown }).toolName;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

function extensionDefinitionHash(hook: ExtensionHookContributionInspection): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([hook.extensionId, hook.revision, hook.event, hook.id, hook.handler]))
    .digest('hex')}`;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_000);
}

async function recordExtensionAudit(
  runtimeEvents: HookRuntimeEventWriter,
  context: ExtensionHookDispatchRuntimeContext,
  audit: HookCompletedAudit,
): Promise<void> {
  await runtimeEvents.appendRuntimeEvent(context.sessionId, context.runId, {
    id: randomUUID(),
    invocationId: context.invocationId,
    runId: context.runId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    ts: Date.now(),
    partial: false,
    role: 'system',
    author: 'host',
    origin: context.origin,
    modelVisibility: 'hidden',
    actions: { hookCompleted: audit },
    refs: { toolCallId: audit.toolUseId },
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
