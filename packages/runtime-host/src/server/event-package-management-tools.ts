import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { OperationKey, OperationOutcome } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import type { HostExtensionRuntime } from './extension-runtime.js';
import { EventPackageActivation } from './event-package-activation.js';
import { EventPackageStore } from './event-package-store.js';

const eventName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u)
  .max(192);
const eventDefinition = z.object({
  name: eventName,
  description: z.string().max(4096).default(''),
  payloadSchema: z.record(z.string(), z.unknown()),
});
const listenerDefinition = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  event: eventName,
  handler: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  priority: z.number().int().min(-10_000).max(10_000).default(0),
  timeoutMs: z.number().int().min(10).max(120_000).default(3_000),
});
const defineInput = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    source: z
      .string()
      .min(1)
      .max(256 * 1024),
    events: z.array(eventDefinition).max(64).default([]),
    listeners: z.array(listenerDefinition).max(64).default([]),
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
  })
  .superRefine((input, context) => {
    if (input.events.length === 0 && input.listeners.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events'],
        message: 'At least one Event or Listener is required',
      });
    }
  });
const revisionInput = z.object({
  extensionId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
});
const testInput = revisionInput.extend({
  listenerId: z.string().min(1).max(128),
  event: eventName,
  payload: z.unknown(),
});
const emitInput = z.object({ event: eventName, payload: z.unknown() });
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

/** Agent-facing authoring, emission, and lifecycle surface for Event/Listener packages. */
export class HostEventPackageManagementTools {
  readonly #draftRoot: string;
  readonly #connection: ConnectionContext = {
    hostEpoch: 'internal-event-package-management',
    connectionId: 'internal-agent-event',
    surface: 'activation',
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };

  constructor(
    controlDirectory: string,
    private readonly controller: HostExtensionController,
    private readonly runtime: HostExtensionRuntime,
    private readonly store: EventPackageStore,
  ) {
    this.#draftRoot = join(controlDirectory, 'event-package-drafts-v1');
  }

  tools(): readonly MakaTool[] {
    return Object.freeze([
      this.#inspect(),
      this.#define(),
      this.#test(),
      this.#emit(),
      this.#manage(),
    ]);
  }

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_events',
      description:
        'Inspect active plugin-defined Event contracts, Event Listeners, immutable revisions, and bindings. Events are in-process Runtime notifications and never create an Agent Turn.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async (_input: Record<string, never>, context: MakaToolContext) => ({
        events: this.runtime.inspectEvents(context.sessionId),
        listeners: this.runtime
          .inspectEventListeners(context.sessionId)
          .map(({ invoke: _invoke, ...listener }) => listener),
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
      name: 'define_event',
      description:
        'Validate, seal, and install an immutable ESM package that provides namespaced JSON-schema Event contracts and/or isolated Listeners. It remains inactive until test_listener and manage_event.',
      parameters: defineInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof defineInput>) => ({
        id: input.id,
        version: input.version,
        sourceAccepted: true,
        sourceBytes: Buffer.byteLength(input.source),
        sourceSha256: createHash('sha256').update(input.source).digest('hex'),
        events: input.events.map(({ name, payloadSchema }) => ({
          name,
          payloadSchemaSha256: createHash('sha256')
            .update(JSON.stringify(payloadSchema))
            .digest('hex'),
        })),
        listeners: input.listeners,
        permissions: input.permissions,
      }),
      impl: async (input: z.infer<typeof defineInput>) => {
        assertSupportedSource(input.source);
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(join(draft, 'dist'), { recursive: true, mode: 0o700 });
          await writeFile(
            join(draft, 'maka.event.json'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                id: input.id,
                version: input.version,
                entry: 'dist/index.mjs',
                events: input.events,
                listeners: input.listeners,
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
      name: 'test_listener',
      description:
        'Invoke one installed Event Listener once in its real OS sandbox without activating or publishing the revision.',
      parameters: testInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof testInput>) => input,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof testInput>, context: MakaToolContext) => {
        const installed = await this.store.load(input.extensionId, input.revision);
        const activation = new EventPackageActivation(installed);
        try {
          await activation.healthCheck();
          const listener = activation
            .listeners()
            .find(({ id, event }) => id === input.listenerId && event === input.event);
          if (!listener)
            throw new Error(`Event package does not declare ${input.event}:${input.listenerId}`);
          await listener.invoke(input.payload, invocationContext(context));
          return { delivered: true };
        } finally {
          await activation.dispose();
        }
      },
    });
  }

  #emit(): MakaTool {
    return Object.freeze({
      name: 'emit_event',
      description:
        'Emit one active plugin-defined Event in the current session. The payload is schema-validated, Listeners run serially by priority in isolated workers, and failures are contained in the delivery report. This does not wake or create an Agent Turn.',
      parameters: emitInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof emitInput>) => ({
        event: input.event,
        payload: input.payload,
      }),
      executionFacts: managementExecutionFacts(),
      impl: (input: z.infer<typeof emitInput>, context: MakaToolContext) =>
        this.runtime.emitEvent(
          context.sessionId,
          input.event,
          input.payload,
          invocationContext(context),
        ),
    });
  }

  #manage(): MakaTool {
    return Object.freeze({
      name: 'manage_event',
      description:
        'Activate, atomically update, stop, or delete an Event/Listener package for the current session. Updates retain the last-good Revision on failed preparation.',
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

function invocationContext(context: MakaToolContext) {
  return {
    sessionId: context.sessionId,
    ...(context.runId ? { runId: context.runId } : {}),
    turnId: context.turnId,
    cwd: context.cwd,
    permissionMode: context.permissionMode ?? 'default',
    origin: 'provider' as const,
    configuration: Object.freeze({}),
    signal: context.abortSignal,
  };
}

function assertSupportedSource(source: string): void {
  if (/\bmodule\s*\.\s*exports\b|\bexports\s*(?:\.|\[)/u.test(source)) {
    throw new Error('Event package source must use ESM, not CommonJS exports.');
  }
  if (!/\bexport\s+default\b/u.test(source)) {
    throw new Error('Event package source must export one default Listener handler object.');
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
  return `agent_event_${digest.slice(0, 32)}`;
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
