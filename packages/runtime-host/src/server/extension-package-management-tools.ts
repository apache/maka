import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { OperationKey, OperationOutcome } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';

const CATEGORIES = [
  'read',
  'web_read',
  'file_write',
  'fs_destructive',
  'shell_safe',
  'shell_unsafe',
  'git_destructive',
  'network_send',
  'subagent',
  'computer_use',
  'client_capability',
] as const;
const RECOVERY_MODES = [
  'replay_safe',
  'idempotent',
  'reconcile',
  'reattach',
  'outcome_unknown',
  'never_auto_retry',
] as const;
const SURFACES = ['app.root', 'app.overlay', 'app.slot'] as const;
const jsonSchema = z.record(z.string(), z.unknown());

const configurationProperty = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    title: z.string().min(1).max(128).optional(),
    description: z.string().max(1024).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .max(64)
      .optional(),
    secret: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (input.secret && input.default !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'secret configuration must not declare a default value',
      });
    }
  });

const toolDeclaration = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(4096),
  handler: z.string().min(1).max(128),
  inputSchema: jsonSchema,
  displayName: z.string().min(1).max(128).optional(),
  category: z.enum(CATEGORIES).optional(),
  recoveryMode: z.enum(RECOVERY_MODES).optional(),
  visualization: z
    .object({ stateKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u) })
    .optional(),
});

const uiContribution = z
  .object({
    id: z.string().min(1).max(128),
    surface: z.enum(SURFACES),
    slot: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)
      .optional(),
    slots: z
      .array(z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u))
      .max(32)
      .optional(),
    priority: z.number().int().min(-10_000).max(10_000),
    document: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .superRefine((input, context) => {
    if (input.surface === 'app.slot' && !input.slot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slot'],
        message: 'slot is required for app.slot',
      });
    }
    if (input.surface !== 'app.slot' && input.slot !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slot'],
        message: 'slot is only valid for app.slot',
      });
    }
  });

const customEventName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u)
  .max(192);
const eventContractDeclaration = z.object({
  name: customEventName,
  description: z.string().max(4096).default(''),
  mode: z
    .enum(['emit', 'parallel', 'serial', 'bail', 'transform', 'observe', 'gate', 'around'])
    .default('emit'),
  payloadSchema: jsonSchema,
  resultSchema: jsonSchema.optional(),
});
const serviceDeclaration = z.object({
  name: customEventName,
  version: z.string().min(1).max(128),
  description: z.string().max(4096).default(''),
  methods: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
        description: z.string().max(4096).default(''),
        handler: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
        inputSchema: jsonSchema,
        outputSchema: jsonSchema,
        timeoutMs: z.number().int().min(10).max(120_000).default(3_000),
      }),
    )
    .min(1)
    .max(64),
});
const timerDeclaration = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  handler: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  intervalMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 24 * 60 * 60 * 1_000),
  initialDelayMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1_000)
    .optional(),
  timeoutMs: z.number().int().min(10).max(120_000).default(3_000),
  payload: z.unknown().optional(),
});
const eventListenerDeclaration = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  event: customEventName,
  handler: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  priority: z.number().int().min(-10_000).max(10_000).default(0),
  timeoutMs: z.number().int().min(10).max(120_000).default(3_000),
});

const definePackageInput = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(4096).optional(),
    dependencies: z
      .array(z.object({ id: z.string().min(1).max(128), version: z.string().min(1).max(128) }))
      .max(64)
      .optional(),
    configuration: z
      .object({
        properties: z.record(z.string(), configurationProperty),
        required: z.array(z.string()).max(128).optional(),
      })
      .optional(),
    runtime: z
      .object({
        source: z
          .string()
          .min(1)
          .max(256 * 1024),
        tools: z.array(toolDeclaration).max(64).default([]),
        events: z.array(eventContractDeclaration).max(64).default([]),
        listeners: z.array(eventListenerDeclaration).max(64).default([]),
        services: z.array(serviceDeclaration).max(64).default([]),
        timers: z.array(timerDeclaration).max(64).default([]),
        permissions: z.object({
          workspace: z.enum(['none', 'read', 'write']),
          network: z.boolean(),
        }),
      })
      .superRefine((input, context) => {
        if (
          input.tools.length === 0 &&
          input.events.length === 0 &&
          input.listeners.length === 0 &&
          input.services.length === 0 &&
          input.timers.length === 0
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'runtime requires at least one Tool, Event, Listener, Service, or Timer',
          });
        }
      })
      .optional(),
    ui: z
      .object({
        contributions: z.array(uiContribution).min(1).max(16),
        permissions: z.object({
          network: z.boolean(),
          hostState: z.boolean().default(false),
          sessionAccess: z.boolean().default(false),
        }),
        host: z
          .object({
            source: z
              .string()
              .min(1)
              .max(1024 * 1024),
            methods: z
              .array(
                z.object({
                  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
                  handler: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
                }),
              )
              .min(1)
              .max(64),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((input, context) => {
    if (!input.runtime && !input.ui) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'define_package requires runtime or ui contributions',
      });
    }
  });

const managePackageInput = z
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

/** Agent-facing authoring surface for one immutable, multi-contribution Extension Revision. */
export class HostExtensionPackageManagementTools {
  readonly #draftRoot: string;
  readonly #connection: ConnectionContext = {
    hostEpoch: 'internal-extension-package-management',
    connectionId: 'internal-agent-extension-package',
    surface: 'activation',
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };

  constructor(
    controlDirectory: string,
    private readonly controller: HostExtensionController,
  ) {
    this.#draftRoot = join(controlDirectory, 'extension-package-drafts-v1');
  }

  tools(): readonly MakaTool[] {
    return Object.freeze([this.#inspect(), this.#define(), this.#manage()]);
  }

  authorTools(): readonly MakaTool[] {
    return Object.freeze(this.tools().filter(({ name }) => name !== 'manage_package'));
  }

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_package',
      description:
        'Inspect the unified immutable Extension package catalog and contracts before defining a package. One Revision may contain Tool, UI, Event, Listener, Service, and Timer contributions together. Configuration properties with secret=true are declared in the contract but their configured values are redacted from query results.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async () => ({
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
      name: 'define_package',
      description:
        'Validate, seal, and install one immutable Extension Revision containing any combination of Tool, UI, Event, Listener, typed Service, and durable host-owned Timer contributions. Trusted executable contributions run in the Runtime Host process and have the same authority as local application or Bash code. All contributions share the same id, version, metadata, dependencies, configuration contract, and content Revision.',
      parameters: definePackageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof definePackageInput>) => ({
        id: input.id,
        version: input.version,
        contributionKinds: [...(input.runtime ? ['runtime'] : []), ...(input.ui ? ['ui'] : [])],
        ...(input.runtime
          ? {
              toolNames: input.runtime.tools.map(({ name }) => name),
              eventNames: input.runtime.events.map(({ name }) => name),
              eventListeners: input.runtime.listeners.map(({ id, event }) => ({ id, event })),
              serviceNames: input.runtime.services.map(({ name }) => name),
              timerIds: input.runtime.timers.map(({ id }) => id),
              runtimeSourceBytes: Buffer.byteLength(input.runtime.source),
              runtimeSourceSha256: digest(input.runtime.source),
              runtimePermissions: input.runtime.permissions,
            }
          : {}),
        ...(input.ui
          ? {
              uiContributionIds: input.ui.contributions.map(({ id }) => id),
              uiDocumentBytes: input.ui.contributions.reduce(
                (total, { document }) => total + Buffer.byteLength(document),
                0,
              ),
              uiDocumentSha256: input.ui.contributions.map(({ document }) => digest(document)),
              uiPermissions: input.ui.permissions,
              ...(input.ui.host
                ? {
                    uiHostMethods: input.ui.host.methods.map(({ name }) => name),
                    uiHostSourceBytes: Buffer.byteLength(input.ui.host.source),
                    uiHostSourceSha256: digest(input.ui.host.source),
                  }
                : {}),
            }
          : {}),
        configurationKeys: Object.keys(input.configuration?.properties ?? {}),
        secretConfigurationKeys: Object.entries(input.configuration?.properties ?? {})
          .filter(([, property]) => property.secret === true)
          .map(([key]) => key),
        historyProjectionNotice:
          'Full trusted Extension source plus UI documents were accepted and intentionally redacted from model history.',
      }),
      impl: async (input: z.infer<typeof definePackageInput>) => {
        if (input.runtime) assertSupportedSource(input.runtime.source, 'Runtime');
        if (input.ui?.host) assertSupportedSource(input.ui.host.source, 'UI Host');
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(draft, { recursive: true, mode: 0o700 });
          if (input.runtime) await this.#writeRuntime(draft, input);
          if (input.ui) await this.#writeUi(draft, input);
          await this.#writeManifest(draft, input);
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

  #manage(): MakaTool {
    return Object.freeze({
      name: 'manage_package',
      description:
        'Activate, update, stop, or delete one trusted Extension package. Tool, Event, Listener, Service, and Timer contributions bind once to the current Session; UI contributions bind once to the Desktop UI scope. Activation executes package code in the Runtime Host process with application-level authority. Multi-scope activation and update roll back to the prior bindings if either scope fails, so a combined package never remains half-switched.',
      parameters: managePackageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof managePackageInput>) => input,
      impl: async (input: z.infer<typeof managePackageInput>, context: MakaToolContext) => {
        const slots = packageBindingSlots(context.sessionId, input.extensionId);
        if (input.action === 'stop') {
          await this.#stopBindings(slots);
          return { extensionId: input.extensionId, revision: null, bindings: [] };
        }
        const revision = requireRevision(input);
        if (input.action === 'delete') {
          await this.#stopBindings(slots);
          return unwrap(
            await this.controller.handlers['extension.package.uninstall'](
              { extensionId: input.extensionId, revision },
              this.#connection,
            ),
          );
        }
        const catalog = unwrap(
          await this.controller.handlers['extension.catalog.query']({}, this.#connection),
        );
        const candidate = catalog.revisions.find(
          (item) => item.extensionId === input.extensionId && item.revision === revision,
        );
        if (!candidate) {
          throw new Error(`Extension Revision is not installed: ${input.extensionId}@${revision}`);
        }
        const desired = [
          {
            ...slots.session,
            needed:
              candidate.toolNames.length > 0 ||
              candidate.eventContributionIds.length > 0 ||
              (candidate.serviceContributionIds?.length ?? 0) > 0 ||
              (candidate.timerContributionIds?.length ?? 0) > 0,
          },
          { ...slots.desktop, needed: candidate.uiContributionIds.length > 0 },
        ];
        const previous = new Map(
          catalog.bindings
            .filter(({ bindingId }) => desired.some((slot) => slot.bindingId === bindingId))
            .map((binding) => [binding.bindingId, binding]),
        );
        try {
          for (const slot of desired) {
            const current = previous.get(slot.bindingId);
            if (!slot.needed) {
              if (current) await this.#removeBinding(slot.bindingId);
              continue;
            }
            if (current) {
              if (current.desiredRevision !== revision || current.status !== 'active') {
                unwrap(
                  await this.controller.handlers['extension.catalog.mutate'](
                    { kind: 'update', bindingId: slot.bindingId, revision },
                    this.#connection,
                  ),
                );
              }
            } else {
              unwrap(
                await this.controller.handlers['extension.catalog.mutate'](
                  {
                    kind: 'enable',
                    bindingId: slot.bindingId,
                    scopeId: slot.scopeId,
                    extensionId: input.extensionId,
                    revision,
                  },
                  this.#connection,
                ),
              );
            }
          }
        } catch (error) {
          await this.#restoreBindings(desired, previous, input.extensionId);
          throw error;
        }
        const updated = unwrap(
          await this.controller.handlers['extension.catalog.query']({}, this.#connection),
        );
        return {
          extensionId: input.extensionId,
          revision,
          bindings: updated.bindings.filter(({ bindingId }) =>
            desired.some((slot) => slot.bindingId === bindingId),
          ),
        };
      },
    });
  }

  async #stopBindings(slots: ReturnType<typeof packageBindingSlots>): Promise<void> {
    const catalog = unwrap(
      await this.controller.handlers['extension.catalog.query']({}, this.#connection),
    );
    const ids = new Set<string>([slots.session.bindingId, slots.desktop.bindingId]);
    for (const binding of catalog.bindings.filter(({ bindingId }) => ids.has(bindingId))) {
      await this.#removeBinding(binding.bindingId);
    }
  }

  async #removeBinding(bindingId: string): Promise<void> {
    unwrap(
      await this.controller.handlers['extension.catalog.mutate'](
        { kind: 'remove', bindingId },
        this.#connection,
      ),
    );
  }

  async #restoreBindings(
    desired: readonly {
      bindingId: string;
      scopeId: string;
      needed: boolean;
    }[],
    previous: ReadonlyMap<
      string,
      {
        readonly bindingId: string;
        readonly scopeId: string;
        readonly extensionId: string;
        readonly desiredRevision: string;
      }
    >,
    extensionId: string,
  ): Promise<void> {
    const current = unwrap(
      await this.controller.handlers['extension.catalog.query']({}, this.#connection),
    );
    const currentById = new Map(current.bindings.map((binding) => [binding.bindingId, binding]));
    for (const slot of [...desired].reverse()) {
      const before = previous.get(slot.bindingId);
      const now = currentById.get(slot.bindingId);
      try {
        if (!before && now) {
          await this.#removeBinding(slot.bindingId);
        } else if (before && now && now.desiredRevision !== before.desiredRevision) {
          unwrap(
            await this.controller.handlers['extension.catalog.mutate'](
              { kind: 'update', bindingId: slot.bindingId, revision: before.desiredRevision },
              this.#connection,
            ),
          );
        } else if (before && !now) {
          unwrap(
            await this.controller.handlers['extension.catalog.mutate'](
              {
                kind: 'enable',
                bindingId: before.bindingId,
                scopeId: before.scopeId,
                extensionId,
                revision: before.desiredRevision,
              },
              this.#connection,
            ),
          );
        }
      } catch {
        // Preserve the original transition failure; the catalog keeps diagnostics for recovery.
      }
    }
  }

  async #writeRuntime(draft: string, input: z.infer<typeof definePackageInput>): Promise<void> {
    const runtime = input.runtime!;
    await mkdir(join(draft, 'dist'), { recursive: true, mode: 0o700 });
    await writeFile(join(draft, 'dist', 'runtime.mjs'), runtime.source, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async #writeUi(draft: string, input: z.infer<typeof definePackageInput>): Promise<void> {
    const ui = input.ui!;
    await mkdir(join(draft, 'documents'), { recursive: true, mode: 0o700 });
    if (ui.host) await mkdir(join(draft, 'host'), { mode: 0o700 });
    await Promise.all(
      ui.contributions.map((item, index) =>
        writeFile(join(draft, 'documents', `${index + 1}.html`), item.document, {
          encoding: 'utf8',
          mode: 0o600,
        }),
      ),
    );
    if (ui.host) {
      await writeFile(join(draft, 'host', 'service.mjs'), ui.host.source, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }

  async #writeManifest(draft: string, input: z.infer<typeof definePackageInput>): Promise<void> {
    await writeJson(draft, 'maka.extension.json', {
      schemaVersion: 1,
      id: input.id,
      version: input.version,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.runtime
        ? {
            runtime: {
              entry: 'dist/runtime.mjs',
              tools: input.runtime.tools,
              events: input.runtime.events,
              listeners: input.runtime.listeners,
              services: input.runtime.services,
              timers: input.runtime.timers,
              permissions: input.runtime.permissions,
            },
          }
        : {}),
      ...(input.ui
        ? {
            ui: {
              contributions: input.ui.contributions.map((item, index) => ({
                id: item.id,
                surface: item.surface,
                ...(item.slot ? { slot: item.slot } : {}),
                ...(item.slots ? { slots: item.slots } : {}),
                priority: item.priority,
                document: `documents/${index + 1}.html`,
              })),
              ...(input.ui.host
                ? { host: { entry: 'host/service.mjs', methods: input.ui.host.methods } }
                : {}),
              permissions: input.ui.permissions,
            },
          }
        : {}),
    });
  }
}

async function writeJson(root: string, file: string, value: unknown): Promise<void> {
  await writeFile(join(root, file), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function assertSupportedSource(source: string, label: string): void {
  if (/\bmodule\s*\.\s*exports\b|\bexports\s*(?:\.|\[)/u.test(source)) {
    throw new Error(`${label} package source must use ESM, not CommonJS exports.`);
  }
  if (!/\bexport\s+default\b/u.test(source)) {
    throw new Error(`${label} package source must export one default handler object.`);
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireRevision(input: z.infer<typeof managePackageInput>): string {
  if (!input.revision) throw new Error(`revision is required for ${input.action}`);
  return input.revision;
}

function packageBindingSlots(sessionId: string, extensionId: string) {
  const digestFor = (scope: string) =>
    createHash('sha256').update(scope).update('\0').update(extensionId).digest('hex').slice(0, 32);
  return {
    session: {
      bindingId: `agent_package_session_${digestFor(sessionId)}`,
      scopeId: sessionId,
    },
    desktop: {
      bindingId: `agent_package_ui_${digestFor('desktop-ui')}`,
      scopeId: 'desktop-ui',
    },
  } as const;
}

function unwrap<K extends OperationKey>(
  outcome: OperationOutcome<K>,
): Extract<OperationOutcome<K>, { ok: true }>['result'] {
  if (outcome.ok) return outcome.result;
  throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
}
