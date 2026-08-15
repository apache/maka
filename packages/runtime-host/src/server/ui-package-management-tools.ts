import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ExtensionUiStateValue, OperationKey, OperationOutcome } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import type { HostExtensionRuntime } from './extension-runtime.js';
import { UiPackageService } from './ui-package-service.js';
import { UiPackageStore } from './ui-package-store.js';

export const DESKTOP_UI_EXTENSION_SCOPE = 'desktop-ui';
const SURFACES = ['app.root', 'app.overlay'] as const;
const contribution = z.object({
  id: z.string().min(1).max(128),
  surface: z.enum(SURFACES),
  priority: z.number().int().min(-10_000).max(10_000),
  document: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
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
    private readonly store: UiPackageStore,
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

  #inspect(): MakaTool {
    return Object.freeze({
      name: 'inspect_ui',
      description:
        'Inspect the independent UI extension surface, installed immutable UI revisions, active Desktop bindings, and the current committed client snapshot.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async () => ({
        surfaces: SURFACES,
        catalog: unwrap(
          await this.controller.handlers['extension.catalog.query']({}, this.#connection),
        ),
        snapshot: unwrap(
          await this.controller.handlers['extension.ui.snapshot'](
            { scopeId: DESKTOP_UI_EXTENSION_SCOPE },
            this.#connection,
          ),
        ),
      }),
    });
  }

  #define(): MakaTool {
    return Object.freeze({
      name: 'define_ui',
      description:
        'Validate and install an immutable UI revision. app.root owns the complete product surface; app.overlay is an independent additive layer. There is no fixed embed region. It is inactive until test_ui and manage_ui. Documents run in opaque-origin sandboxed iframes without Electron or Maka preload authority. Set permissions.hostState=true for durable package state. Set permissions.sessionAccess=true only for a complete root that must list/create/send/stop Maka Sessions through the typed window.makaUI.sessions bridge. Add host.source plus declared methods for sandboxed package-private backend handlers callable with window.makaUI.invoke(name, args).',
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
            priority: item.priority,
            document: `documents/${index + 1}.html`,
          }));
          await writeFile(
            join(draft, 'maka.ui.json'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                id: input.id,
                version: input.version,
                ui: manifestUi,
                ...(input.host
                  ? {
                      host: { entry: 'host/service.mjs', methods: input.host.methods },
                    }
                  : {}),
                permissions: input.permissions,
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
        const installed = await this.store.load(input.extensionId, input.revision);
        const service = new UiPackageService();
        const loaded = {
          extensionId: installed.extensionId,
          revision: installed.revision,
          ui: await Promise.all(
            installed.manifest.ui.map(async (item) => ({
              id: item.id,
              surface: item.surface,
              priority: item.priority,
              document: await this.store.readDocument(installed, item.document),
              network: installed.manifest.permissions.network,
              hostState: installed.manifest.permissions.hostState,
              hostMethods: Object.freeze(
                installed.manifest.host?.methods.map(({ name }) => name) ?? [],
              ),
              sessionAccess: installed.manifest.permissions.sessionAccess,
            })),
          ),
          healthCheck: () => service.healthCheck(installed),
        };
        if (
          !this.runtime
            .installedRevisions()
            .some(
              (item) => item.extensionId === input.extensionId && item.revision === input.revision,
            )
        ) {
          await this.runtime.installUiRevision(loaded);
        }
        const nonce = randomUUID().replaceAll('-', '');
        const scopeId = `ui-preview-${nonce}`;
        const bindingId = `ui-preview-binding-${nonce}`;
        try {
          await this.runtime.activate({
            bindingId,
            scopeId,
            extensionId: input.extensionId,
            revision: input.revision,
          });
          return { ok: true, contributions: this.runtime.inspectUi(scopeId) };
        } finally {
          try {
            await this.runtime.removeBinding(bindingId);
          } catch {
            /* diagnostic remains inspectable */
          }
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
