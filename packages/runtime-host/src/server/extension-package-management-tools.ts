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
const extensionName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u)
  .max(192);
const invokeToolInput = z.object({
  toolName: z.string().min(1).max(128),
  args: z.unknown(),
});
const emitEventInput = z.object({ event: extensionName, payload: z.unknown() });
const callServiceInput = z.object({
  service: extensionName,
  method: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u),
  input: z.unknown(),
});
const uiStateValueSchema: z.ZodType<
  null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>
> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(uiStateValueSchema),
    z.record(z.string(), uiStateValueSchema),
  ]),
);
const publishUiStateInput = z.object({
  extensionId: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  value: uiStateValueSchema,
});
const PACKAGE_TOOL_NAMES = new Set([
  'inspect_package',
  'define_package',
  'manage_package',
  'invoke_tool',
  'emit_event',
  'call_service',
  'publish_ui_state',
]);

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
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(4096).optional(),
    dependencies: z
      .array(z.object({ id: z.string().min(1).max(128) }))
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

const managePackageInput = z.object({
  action: z.enum(['activate', 'reload', 'stop', 'delete']),
  extensionId: z.string().min(1).max(128),
});

/** Agent-facing authoring surface for one multi-contribution Extension. */
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
    return Object.freeze([
      this.#inspect(),
      this.#define(),
      this.#manage(),
      this.#invokeTool(),
      this.#emitEvent(),
      this.#callService(),
      this.#publishUiState(),
    ]);
  }

  authorTools(): readonly MakaTool[] {
    return Object.freeze([this.#inspect(), this.#define()]);
  }

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_package',
      description:
        'Inspect the unified Extension catalog and contracts before defining a package. One Extension may contain Tool, UI, Event, Listener, Service, and Timer contributions together. Configuration properties with secret=true are declared in the contract but their configured values are redacted from query results.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async () => ({
        catalog: unwrap(
          await this.controller.handlers['extension.composition.query']({}, this.#connection),
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
        'Validate and install one Extension containing any combination of Tool, UI, Event, Listener, typed Service, and durable host-owned Timer contributions. Trusted executable contributions run in the Runtime Host process and have the same authority as local application or Bash code. All contributions share the same identity, metadata, dependencies, and configuration contract.',
      parameters: definePackageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof definePackageInput>) => ({
        id: input.id,
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
        'Activate, reload, stop, or delete one trusted Extension package. Tool, Event, Listener, Service, and Timer contributions bind once to the current Session; UI contributions bind once to the Desktop UI scope. Activation executes package code in the Runtime Host process with application-level authority. Multi-scope activation and reload roll back to the prior Entry Tree if either scope fails.',
      parameters: managePackageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof managePackageInput>) => input,
      impl: async (input: z.infer<typeof managePackageInput>, context: MakaToolContext) => {
        const slots = packageEntrySlots(context.sessionId, input.extensionId);
        if (input.action === 'stop') {
          await this.#stopEntries(slots);
          return { extensionId: input.extensionId, entries: [] };
        }
        if (input.action === 'delete') {
          await this.#stopEntries(slots);
          return unwrap(
            await this.controller.handlers['extension.package.uninstall'](
              { extensionId: input.extensionId },
              this.#connection,
            ),
          );
        }
        const catalog = unwrap(
          await this.controller.handlers['extension.composition.query']({}, this.#connection),
        );
        const candidate = catalog.extensions.find((item) => item.extensionId === input.extensionId);
        if (!candidate) {
          throw new Error(`Extension is not installed: ${input.extensionId}`);
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
          catalog.entries
            .filter(({ entryId }) => desired.some((slot) => slot.entryId === entryId))
            .map((entry) => [entry.entryId, entry]),
        );
        try {
          for (const slot of desired) {
            const current = previous.get(slot.entryId);
            if (!slot.needed) {
              if (current) await this.#removeEntry(slot.entryId);
              continue;
            }
            if (current) {
              if (input.action === 'reload' || current.status !== 'active') {
                unwrap(
                  await this.controller.handlers['extension.composition.mutate'](
                    { kind: 'reload', entryId: slot.entryId },
                    this.#connection,
                  ),
                );
              }
            } else {
              unwrap(
                await this.controller.handlers['extension.composition.mutate'](
                  {
                    kind: 'enable',
                    entryId: slot.entryId,
                    scopeId: slot.scopeId,
                    extensionId: input.extensionId,
                  },
                  this.#connection,
                ),
              );
            }
          }
        } catch (error) {
          await this.#restoreEntries(desired, previous, input.extensionId);
          throw error;
        }
        const updated = unwrap(
          await this.controller.handlers['extension.composition.query']({}, this.#connection),
        );
        return {
          extensionId: input.extensionId,
          entries: updated.entries.filter(({ entryId }) =>
            desired.some((slot) => slot.entryId === entryId),
          ),
        };
      },
    });
  }

  #invokeTool(): MakaTool {
    return Object.freeze({
      name: 'invoke_tool',
      description:
        'Immediately invoke an active Extension Tool by name, including after package activation in the same model turn before native Tool schemas refresh.',
      parameters: invokeToolInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof invokeToolInput>) => input,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof invokeToolInput>, context: MakaToolContext) => {
        if (PACKAGE_TOOL_NAMES.has(input.toolName)) {
          throw new Error(
            `Extension Package Tools cannot be invoked recursively: ${input.toolName}`,
          );
        }
        const tool = this.controller.resolveTool(context.sessionId, input.toolName);
        if (!tool) throw new Error(`Active Extension Tool was not found: ${input.toolName}`);
        await validateArgs(tool, input.args);
        return await tool.impl(input.args, context);
      },
    });
  }

  #emitEvent(): MakaTool {
    return Object.freeze({
      name: 'emit_event',
      description:
        'Dispatch one active typed Extension Event in the current session without creating an Agent Turn.',
      parameters: emitEventInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof emitEventInput>) => input,
      executionFacts: managementExecutionFacts(),
      impl: (input: z.infer<typeof emitEventInput>, context: MakaToolContext) =>
        this.controller.emitEvent(context.sessionId, input.event, input.payload, context),
    });
  }

  #callService(): MakaTool {
    return Object.freeze({
      name: 'call_service',
      description:
        'Call one active typed trusted Extension Service method. Input and output are JSON-schema validated.',
      parameters: callServiceInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (input: z.infer<typeof callServiceInput>) => input,
      executionFacts: managementExecutionFacts(),
      impl: (input: z.infer<typeof callServiceInput>, context: MakaToolContext) =>
        this.controller.callService(
          context.sessionId,
          input.service,
          input.method,
          input.input,
          context,
        ),
    });
  }

  #publishUiState(): MakaTool {
    return Object.freeze({
      name: 'publish_ui_state',
      description:
        'Publish structured business state to every active Desktop UI Entry for one Extension that allows Host state.',
      parameters: publishUiStateInput,
      categoryHint: 'client_capability',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof publishUiStateInput>) => ({
        extensionId: input.extensionId,
        key: input.key,
        valueRedacted: true,
        valueSha256: digest(JSON.stringify(input.value) ?? 'null'),
      }),
      impl: async (input: z.infer<typeof publishUiStateInput>) => {
        await this.controller.publishUiState(input.extensionId, input.key, input.value);
        return { extensionId: input.extensionId, key: input.key, published: true };
      },
    });
  }

  async #stopEntries(slots: ReturnType<typeof packageEntrySlots>): Promise<void> {
    const catalog = unwrap(
      await this.controller.handlers['extension.composition.query']({}, this.#connection),
    );
    const ids = new Set<string>([slots.session.entryId, slots.desktop.entryId]);
    for (const entry of catalog.entries.filter(({ entryId }) => ids.has(entryId))) {
      await this.#removeEntry(entry.entryId);
    }
  }

  async #removeEntry(entryId: string): Promise<void> {
    unwrap(
      await this.controller.handlers['extension.composition.mutate'](
        { kind: 'remove', entryId },
        this.#connection,
      ),
    );
  }

  async #restoreEntries(
    desired: readonly {
      entryId: string;
      scopeId: string;
      needed: boolean;
    }[],
    previous: ReadonlyMap<
      string,
      {
        readonly entryId: string;
        readonly scopeId: string;
        readonly extensionId: string;
        readonly generation: number;
      }
    >,
    extensionId: string,
  ): Promise<void> {
    const current = unwrap(
      await this.controller.handlers['extension.composition.query']({}, this.#connection),
    );
    const currentById = new Map(current.entries.map((entry) => [entry.entryId, entry]));
    for (const slot of [...desired].reverse()) {
      const before = previous.get(slot.entryId);
      const now = currentById.get(slot.entryId);
      try {
        if (!before && now) {
          await this.#removeEntry(slot.entryId);
        } else if (before && now && now.generation !== before.generation) {
          unwrap(
            await this.controller.handlers['extension.composition.mutate'](
              { kind: 'reload', entryId: slot.entryId },
              this.#connection,
            ),
          );
        } else if (before && !now) {
          unwrap(
            await this.controller.handlers['extension.composition.mutate'](
              {
                kind: 'enable',
                entryId: before.entryId,
                scopeId: before.scopeId,
                extensionId,
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

function packageEntrySlots(sessionId: string, extensionId: string) {
  const digestFor = (scope: string) =>
    createHash('sha256').update(scope).update('\0').update(extensionId).digest('hex').slice(0, 32);
  return {
    session: {
      entryId: `agent_package_session_${digestFor(sessionId)}`,
      scopeId: sessionId,
    },
    desktop: {
      entryId: `agent_package_ui_${digestFor('desktop-ui')}`,
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

async function validateArgs(tool: MakaTool, args: unknown): Promise<void> {
  const schema = tool.parameters as {
    safeParseAsync?: (value: unknown) => Promise<{ success: boolean; error?: unknown }>;
    safeParse?: (value: unknown) => { success: boolean; error?: unknown };
  };
  const result = schema.safeParseAsync
    ? await schema.safeParseAsync(args)
    : schema.safeParse?.(args);
  if (result && !result.success) {
    throw new Error(`Tool arguments failed validation: ${String(result.error)}`);
  }
}

function managementExecutionFacts(): NonNullable<MakaTool['executionFacts']> {
  return Object.freeze({
    isolation: 'none',
    writesAffectHost: true,
    writeBack: 'direct',
    network: 'host',
    secrets: 'host_env',
  });
}
