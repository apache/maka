import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXTENSION_HOOK_EVENTS,
  modeForEvent,
  type ExtensionHookEventName,
} from '@maka/runtime/extension-hook-contributions';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { OperationKey, OperationOutcome } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import type { HostExtensionRuntime } from './extension-runtime.js';
import { HookPackageActivation } from './hook-package-activation.js';
import { HookPackageStore } from './hook-package-store.js';

const EVENTS = EXTENSION_HOOK_EVENTS;
const eventSchema = z.enum(EVENTS);
const hookDeclaration = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  event: eventSchema,
  handler: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  matcher: z.string().min(1).max(256).optional(),
  priority: z.number().int().min(-10_000).max(10_000).default(0),
  timeoutMs: z.number().int().min(10).max(120_000).default(3_000),
});
const defineInput = z.object({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  source: z
    .string()
    .min(1)
    .max(256 * 1024),
  hooks: z.array(hookDeclaration).min(1).max(64),
  permissions: z.object({
    workspace: z.enum(['none', 'read']),
    network: z.boolean(),
  }),
  displayName: z.string().min(1).max(128).optional(),
  description: z.string().max(4096).optional(),
  dependencies: z
    .array(z.object({ id: z.string().min(1).max(128), version: z.string().min(1).max(128) }))
    .max(64)
    .optional(),
  configuration: z
    .object({
      properties: z.record(
        z.string(),
        z.object({
          type: z.enum(['string', 'number', 'boolean']),
          title: z.string().min(1).max(128).optional(),
          description: z.string().max(1024).optional(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          enum: z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .max(64)
            .optional(),
          secret: z.boolean().optional(),
        }),
      ),
      required: z.array(z.string()).max(128).optional(),
    })
    .optional(),
});
const revisionInput = z.object({
  extensionId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
});
const testInput = revisionInput.extend({
  event: eventSchema,
  hookId: z.string().min(1).max(128),
  payload: z.unknown(),
});
const manageInput = z
  .object({
    action: z.enum(['activate', 'update', 'stop', 'delete']),
    extensionId: z.string().min(1).max(128),
    revision: z.string().min(1).max(128).optional(),
  })
  .superRefine((input, context) => {
    if (input.action !== 'stop' && input.revision === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision'],
        message: `revision is required for ${input.action}`,
      });
    }
  });

/** Agent-facing authoring and lifecycle surface for isolated Runtime Hook contributions. */
export class HostHookPackageManagementTools {
  readonly #draftRoot: string;
  readonly #connection: ConnectionContext = {
    hostEpoch: 'internal-hook-package-management',
    connectionId: 'internal-agent-hook',
    surface: 'activation',
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };

  constructor(
    controlDirectory: string,
    private readonly controller: HostExtensionController,
    private readonly runtime: HostExtensionRuntime,
    private readonly store: HookPackageStore,
  ) {
    this.#draftRoot = join(controlDirectory, 'hook-package-drafts-v1');
  }

  tools(): readonly MakaTool[] {
    return Object.freeze([this.#inspect(), this.#define(), this.#test(), this.#manage()]);
  }

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_hooks',
      description:
        'Inspect the typed Runtime Hook surface, dispatch modes, installed immutable revisions, and active bindings. Hook contributions share the same lifecycle as Tool and UI contributions.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async (_input: Record<string, never>, context: MakaToolContext) => ({
        events: EVENTS.map((event) => ({ event, mode: modeForEvent(event) })),
        active: this.runtime
          .inspectHooks(context.sessionId)
          .map(({ invoke: _invoke, ...hook }) => hook),
        catalog: unwrap(
          await this.controller.handlers['extension.catalog.query']({}, this.#connection),
        ),
        contracts: unwrap(
          await this.controller.handlers['extension.contract.query']({}, this.#connection),
        ),
      }),
    });
  }

  #define(): MakaTool {
    return Object.freeze({
      name: 'define_hook',
      description:
        'Validate, seal, and install an immutable ESM Hook revision. It remains inactive until test_hook and manage_hook. UserPromptSubmit and PostToolUse transform payloads, PreToolUse may deny, and RunStart/RunEnd observe only.',
      parameters: defineInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof defineInput>) => ({
        id: input.id,
        version: input.version,
        sourceAccepted: true,
        sourceBytes: Buffer.byteLength(input.source),
        sourceSha256: createHash('sha256').update(input.source).digest('hex'),
        hooks: input.hooks.map(({ id, event, matcher, priority, timeoutMs }) => ({
          id,
          event,
          mode: modeForEvent(event),
          ...(matcher ? { matcher } : {}),
          priority,
          timeoutMs,
        })),
        permissions: input.permissions,
      }),
      impl: async (input: z.infer<typeof defineInput>) => {
        assertSupportedSource(input.source);
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(join(draft, 'dist'), { recursive: true, mode: 0o700 });
          await writeFile(
            join(draft, 'maka.hook.json'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                id: input.id,
                version: input.version,
                entry: 'dist/index.mjs',
                hooks: input.hooks.map((hook) => ({
                  ...hook,
                  mode: modeForEvent(hook.event),
                })),
                permissions: input.permissions,
              },
              null,
              2,
            )}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await writeFile(
            join(draft, 'maka.extension.json'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                id: input.id,
                version: input.version,
                ...(input.displayName ? { displayName: input.displayName } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                ...(input.dependencies ? { dependencies: input.dependencies } : {}),
                ...(input.configuration ? { configuration: input.configuration } : {}),
              },
              null,
              2,
            )}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await writeFile(join(draft, 'dist', 'index.mjs'), input.source, {
            encoding: 'utf8',
            mode: 0o600,
          });
          return unwrap(
            await this.controller.handlers['extension.package.install'](
              { sourcePath: draft },
              this.#connection,
            ),
          );
        } finally {
          await rm(draft, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    });
  }

  #test(): MakaTool {
    return Object.freeze({
      name: 'test_hook',
      description:
        'Invoke one installed Hook handler once in its real OS sandbox without activating or publishing the revision.',
      parameters: testInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof testInput>) => input,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof testInput>, context: MakaToolContext) => {
        const installed = await this.store.load(input.extensionId, input.revision);
        const activation = new HookPackageActivation(installed);
        try {
          await activation.healthCheck();
          const hook = activation
            .contributions()
            .find(({ id, event }) => id === input.hookId && event === input.event);
          if (!hook)
            throw new Error(`Hook package does not declare ${input.event}:${input.hookId}`);
          return await hook.invoke(input.payload, {
            sessionId: context.sessionId,
            ...(context.runId ? { runId: context.runId } : {}),
            turnId: context.turnId,
            cwd: context.cwd,
            permissionMode: context.permissionMode ?? 'default',
            origin: 'provider',
            configuration: Object.freeze({}),
            signal: context.abortSignal,
          });
        } finally {
          await activation.dispose();
        }
      },
    });
  }

  #manage(): MakaTool {
    return Object.freeze({
      name: 'manage_hook',
      description:
        'Activate, atomically update, stop, or delete a Hook package for the current session. Updates retain the last-good Revision on failed preparation.',
      parameters: manageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof manageInput>) => input,
      impl: async (input: z.infer<typeof manageInput>, context: MakaToolContext) => {
        const bindingId = bindingIdFor(context.sessionId, input.extensionId);
        switch (input.action) {
          case 'activate':
            return unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                {
                  kind: 'enable',
                  bindingId,
                  scopeId: context.sessionId,
                  extensionId: input.extensionId,
                  revision: requireRevision(input),
                },
                this.#connection,
              ),
            );
          case 'update':
            return unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                { kind: 'update', bindingId, revision: requireRevision(input) },
                this.#connection,
              ),
            );
          case 'stop':
            return unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                { kind: 'remove', bindingId },
                this.#connection,
              ),
            );
          case 'delete': {
            const catalog = unwrap(
              await this.controller.handlers['extension.catalog.query']({}, this.#connection),
            );
            if (catalog.bindings.some((binding) => binding.bindingId === bindingId)) {
              unwrap(
                await this.controller.handlers['extension.catalog.mutate'](
                  { kind: 'remove', bindingId },
                  this.#connection,
                ),
              );
            }
            return unwrap(
              await this.controller.handlers['extension.package.uninstall'](
                { extensionId: input.extensionId, revision: requireRevision(input) },
                this.#connection,
              ),
            );
          }
        }
      },
    });
  }
}

function assertSupportedSource(source: string): void {
  if (/\bmodule\s*\.\s*exports\b|\bexports\s*(?:\.|\[)/u.test(source)) {
    throw new Error('Hook package source must use ESM, not CommonJS exports.');
  }
  if (!/\bexport\s+default\b/u.test(source)) {
    throw new Error('Hook package source must export one default handler object.');
  }
}

function requireRevision(input: z.infer<typeof manageInput>): string {
  if (!input.revision) throw new Error(`revision is required for ${input.action}`);
  return input.revision;
}

function bindingIdFor(sessionId: string, extensionId: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(extensionId)
    .digest('hex');
  return `agent_hook_${digest.slice(0, 32)}`;
}

function unwrap<K extends OperationKey>(
  outcome: OperationOutcome<K>,
): Extract<OperationOutcome<K>, { ok: true }>['result'] {
  if (outcome.ok) return outcome.result;
  throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
}

function managementExecutionFacts(): NonNullable<MakaTool['executionFacts']> {
  return Object.freeze({
    isolation: 'container',
    writesAffectHost: true,
    writeBack: 'direct',
    network: 'sandbox',
    secrets: 'none',
  });
}

export function hookDispatchMode(event: ExtensionHookEventName) {
  return modeForEvent(event);
}
