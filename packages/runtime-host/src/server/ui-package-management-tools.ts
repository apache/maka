import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import {
  EXTENSION_UI_OFFICIAL_SLOTS,
  type ExtensionUiStateValue,
  type OperationKey,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import { HostExtensionRuntime } from './extension-runtime.js';
import { UiPackageService } from './ui-package-service.js';
import { PluginPackageStore } from './plugin-package-store.js';

export const DESKTOP_UI_EXTENSION_SCOPE = 'desktop-ui';
const AUTHOR_UI_TOOL_NAMES = new Set(['inspect_ui', 'define_ui', 'test_ui']);
const SURFACES = ['app.root', 'app.overlay', 'app.slot'] as const;
const contribution = z
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
const extensionMetadata = {
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
};
const defineInput = z.object({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  ui: z.array(contribution).min(1).max(16),
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
  ...extensionMetadata,
});
const revisionInput = z.object({
  extensionId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
});
const uiStateValueSchema: z.ZodType<ExtensionUiStateValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(uiStateValueSchema),
    z.record(z.string(), uiStateValueSchema),
  ]),
);
const publishStateInput = z.object({
  extensionId: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  value: uiStateValueSchema,
});
const manageInput = z
  .object({
    action: z.enum(['activate', 'update', 'stop', 'delete']),
    extensionId: z.string().min(1).max(128),
    revision: z.string().min(1).max(128).optional(),
  })
  .superRefine((input, context) => {
    if (input.action !== 'stop' && !input.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision'],
        message: 'revision is required',
      });
    }
  });

/** Agent-facing authoring surface for client-only, sandboxed UI revisions. */
export class HostUiPackageManagementTools {
  readonly #draftRoot: string;
  readonly #connection: ConnectionContext = {
    hostEpoch: 'internal-ui-package-management',
    connectionId: 'internal-agent-ui',
    surface: 'activation',
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };

  constructor(
    controlDirectory: string,
    private readonly controller: HostExtensionController,
    private readonly runtime: HostExtensionRuntime,
    private readonly store: PluginPackageStore,
  ) {
    this.#draftRoot = join(controlDirectory, 'ui-package-drafts-v1');
  }

  tools(): readonly MakaTool[] {
    return Object.freeze([
      this.#inspect(),
      this.#define(),
      this.#test(),
      this.#manage(),
      this.#publishState(),
    ]);
  }

  /** Safe child-authoring subset: install and test candidates without Desktop binding or state authority. */
  authorTools(): readonly MakaTool[] {
    return Object.freeze(this.tools().filter((tool) => AUTHOR_UI_TOOL_NAMES.has(tool.name)));
  }

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_ui',
      description:
        'Inspect the independent UI extension surface, official composition slots, installed immutable UI revisions, active Desktop bindings, and the current committed client snapshot.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async () => {
        const catalog = unwrap(
          await this.controller.handlers['extension.catalog.query']({}, this.#connection),
        );
        const snapshot = unwrap(
          await this.controller.handlers['extension.ui.snapshot'](
            { scopeId: DESKTOP_UI_EXTENSION_SCOPE },
            this.#connection,
          ),
        );
        const contracts = unwrap(
          await this.controller.handlers['extension.contract.query']({}, this.#connection),
        );
        const dynamicRoot = snapshot.contributions.find(({ surface }) => surface === 'app.root');
        const slots = dynamicRoot
          ? reachableSlots(dynamicRoot, snapshot.contributions)
          : EXTENSION_UI_OFFICIAL_SLOTS;
        return {
          surfaces: SURFACES,
          slots,
          slotCompatibility: {
            compatible: true,
            rootExtensionId: dynamicRoot?.extensionId ?? 'dev.maka.desktop',
            dynamic: Boolean(dynamicRoot),
          },
          catalog,
          contracts,
          snapshot,
        };
      },
    });
  }

  #define(): MakaTool {
    return Object.freeze({
      name: 'define_ui',
      description:
        'Validate and install an immutable UI revision. app.root owns the complete product surface, app.overlay is an independent additive layer, and app.slot contributes an independently updateable sandboxed component to one slot returned by inspect_ui. It is inactive until test_ui and manage_ui. Documents run in opaque-origin sandboxed iframes without Electron or Maka preload authority. Set permissions.hostState=true for durable package state. Set permissions.sessionAccess=true only for a complete root that must list/create/send/stop Maka Sessions through the typed window.makaUI.sessions bridge. Add host.source plus declared methods for sandboxed package-private backend handlers callable with window.makaUI.invoke(name, args).',
      parameters: defineInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof defineInput>) => ({
        id: input.id,
        version: input.version,
        uiAccepted: true,
        contributionIds: input.ui.map(({ id }) => id),
        documentBytes: input.ui.reduce((sum, item) => sum + Buffer.byteLength(item.document), 0),
        documentSha256: input.ui.map(({ document }) =>
          createHash('sha256').update(document).digest('hex'),
        ),
        ...(input.host
          ? {
              hostMethods: input.host.methods.map(({ name }) => name),
              hostSourceBytes: Buffer.byteLength(input.host.source),
              hostSourceSha256: createHash('sha256').update(input.host.source).digest('hex'),
            }
          : {}),
        permissions: input.permissions,
        historyProjectionNotice:
          'Full UI documents and Host source were accepted and intentionally redacted from model history.',
      }),
      impl: async (input: z.infer<typeof defineInput>) => {
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(join(draft, 'documents'), { recursive: true, mode: 0o700 });
          if (input.host) await mkdir(join(draft, 'host'), { mode: 0o700 });
          const manifestUi = input.ui.map((item, index) => ({
            id: item.id,
            surface: item.surface,
            ...(item.slot ? { slot: item.slot } : {}),
            ...(item.slots ? { slots: item.slots } : {}),
            priority: item.priority,
            document: `documents/${index + 1}.html`,
          }));
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
                ui: {
                  contributions: manifestUi,
                  ...(input.host
                    ? {
                        host: { entry: 'host/service.mjs', methods: input.host.methods },
                      }
                    : {}),
                  permissions: input.permissions,
                },
              },
              null,
              2,
            )}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await Promise.all(
            input.ui.map((item, index) =>
              writeFile(join(draft, 'documents', `${index + 1}.html`), item.document, {
                encoding: 'utf8',
                mode: 0o600,
              }),
            ),
          );
          if (input.host) {
            await writeFile(join(draft, 'host', 'service.mjs'), input.host.source, {
              encoding: 'utf8',
              mode: 0o600,
            });
          }
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
      name: 'test_ui',
      description:
        'Validate one installed UI revision through the real Extension lifecycle in an isolated preview scope without changing the Desktop UI.',
      parameters: revisionInput,
      categoryHint: 'read',
      recoveryMode: 'never_auto_retry',
      impl: async (input: z.infer<typeof revisionInput>) => {
        const installed = await this.store.loadUi(input.extensionId, input.revision);
        const service = new UiPackageService();
        const loaded = {
          extensionId: installed.extensionId,
          revision: installed.revision,
          ui: await Promise.all(
            installed.manifest.ui.map(async (item) => ({
              id: item.id,
              surface: item.surface,
              ...(item.slot ? { slot: item.slot } : {}),
              slots: item.slots,
              priority: item.priority,
              document: await this.store.readDocument(installed, item.document),
              network: installed.manifest.permissions.network,
              hostState: installed.manifest.permissions.hostState,
              hostMethods: Object.freeze(
                installed.manifest.host?.methods.map(({ name }) => name) ?? [],
              ),
              sessionAccess:
                installed.manifest.permissions.sessionAccess && item.surface === 'app.root',
            })),
          ),
          healthCheck: () => service.healthCheck(installed),
        };
        // A package Revision may also carry Tool and Hook contributions. Testing its UI
        // through the shared Runtime would activate that complete Revision in the preview
        // scope and can perturb the later package lifecycle. Keep previews in a separate
        // Runtime so test_ui exercises only the installed UI package it loaded above.
        const previewRuntime = new HostExtensionRuntime();
        await previewRuntime.installUiRevision(loaded);
        const nonce = randomUUID().replaceAll('-', '');
        const scopeId = `ui-preview-${nonce}`;
        const bindingId = `ui-preview-binding-${nonce}`;
        try {
          await previewRuntime.activate({
            bindingId,
            scopeId,
            extensionId: input.extensionId,
            revision: input.revision,
          });
          return { ok: true, contributions: previewRuntime.inspectUi(scopeId) };
        } finally {
          await previewRuntime.close().catch(() => undefined);
        }
      },
    });
  }

  #manage(): MakaTool {
    return Object.freeze({
      name: 'manage_ui',
      description:
        'Activate, atomically update, stop, or delete a client-only UI package in the Desktop UI scope. A failed candidate keeps the current UI revision.',
      parameters: manageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof manageInput>) => input,
      impl: async (input: z.infer<typeof manageInput>) => {
        const bindingId = bindingIdFor(input.extensionId);
        if (input.action === 'activate') {
          return unwrap(
            await this.controller.handlers['extension.catalog.mutate'](
              {
                kind: 'enable',
                bindingId,
                scopeId: DESKTOP_UI_EXTENSION_SCOPE,
                extensionId: input.extensionId,
                revision: requireRevision(input),
              },
              this.#connection,
            ),
          );
        }
        if (input.action === 'update') {
          return unwrap(
            await this.controller.handlers['extension.catalog.mutate'](
              {
                kind: 'update',
                bindingId,
                revision: requireRevision(input),
              },
              this.#connection,
            ),
          );
        }
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
        if (input.action === 'delete') {
          return unwrap(
            await this.controller.handlers['extension.package.uninstall'](
              {
                extensionId: input.extensionId,
                revision: requireRevision(input),
              },
              this.#connection,
            ),
          );
        }
        return { binding: null };
      },
    });
  }

  #publishState(): MakaTool {
    return Object.freeze({
      name: 'publish_ui_state',
      description:
        'Publish structured business state to one already-active Desktop UI Extension. The input MUST include the literal `value` JSON object. Never copy `valueAccepted`, `valueSha256`, `valueRedacted`, or `historyProjectionNotice` fields from prior tool history: those are redacted audit summaries and are not valid input. Use this after a business Tool returns a snapshot or patch so the UI can render the real Tool result. The active UI must declare permissions.hostState=true. This Tool never invokes the UI and cannot activate or update UI code.',
      parameters: publishStateInput,
      categoryHint: 'client_capability',
      recoveryMode: 'idempotent',
      permissionArgs: (input: z.infer<typeof publishStateInput>) => ({
        extensionId: input.extensionId,
        key: input.key,
        historyProjectionNotice:
          'The literal value was accepted and redacted from history. On a future call, provide the full `value` object again; do not pass this summary as input.',
        valueRedacted: true,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(input.value) ?? 'null')
          .digest('hex'),
      }),
      impl: async (input: z.infer<typeof publishStateInput>) => {
        const contribution = this.runtime
          .inspectUi(DESKTOP_UI_EXTENSION_SCOPE)
          .find((item) => item.extensionId === input.extensionId);
        if (!contribution) {
          throw new Error(`Active Desktop UI Extension was not found: ${input.extensionId}`);
        }
        if (!contribution.hostState) {
          throw new Error(
            `Active Desktop UI Extension does not allow Host state: ${input.extensionId}`,
          );
        }
        const result = unwrap(
          await this.controller.handlers['extension.ui.state.mutate'](
            {
              scopeId: DESKTOP_UI_EXTENSION_SCOPE,
              bindingId: contribution.bindingId,
              extensionId: contribution.extensionId,
              revision: contribution.revision,
              key: input.key,
              kind: 'set',
              value: input.value,
            },
            this.#connection,
          ),
        );
        return {
          ...result,
          extensionId: contribution.extensionId,
          revision: contribution.revision,
          key: input.key,
        };
      },
    });
  }
}

function reachableSlots(
  root: {
    readonly slots?: readonly string[];
    readonly bindingId: string;
    readonly revision: string;
    readonly id: string;
  },
  contributions: readonly {
    readonly surface: string;
    readonly slot?: string;
    readonly slots?: readonly string[];
    readonly bindingId: string;
    readonly revision: string;
    readonly id: string;
    readonly priority: number;
    readonly extensionId: string;
  }[],
): readonly string[] {
  const available = new Set(root.slots ?? []);
  const visited = new Set([`${root.bindingId}:${root.revision}:${root.id}`]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of contributions) {
      const key = `${item.bindingId}:${item.revision}:${item.id}`;
      if (
        item.surface !== 'app.slot' ||
        !item.slot ||
        !available.has(item.slot) ||
        visited.has(key)
      ) {
        continue;
      }
      visited.add(key);
      for (const slot of item.slots ?? []) {
        if (!available.has(slot)) {
          available.add(slot);
          changed = true;
        }
      }
    }
  }
  return Object.freeze([...available].sort());
}

function bindingIdFor(extensionId: string): string {
  return `agent_ui_${createHash('sha256').update(extensionId).digest('hex').slice(0, 32)}`;
}

function requireRevision(input: z.infer<typeof manageInput>): string {
  if (!input.revision) throw new Error(`revision is required for ${input.action}`);
  return input.revision;
}

function unwrap<K extends OperationKey>(
  outcome: OperationOutcome<K>,
): Extract<OperationOutcome<K>, { ok: true }>['result'] {
  if (outcome.ok) return outcome.result;
  throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
}
