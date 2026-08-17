import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type {
  ExtensionCatalogMutateResult,
  ExtensionCatalogQueryResult,
  ExtensionUiStateValue,
  OperationKey,
  OperationOutcome,
} from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import type { HostExtensionRuntime } from './extension-runtime.js';
import { InProcessPackageActivation } from './in-process-package-runtime.js';
import { ToolPackageStore } from './tool-package-store.js';

const MANAGEMENT_TOOL_NAMES = new Set([
  'inspect_package',
  'define_package',
  'manage_package',
  'inspect_tools',
  'define_tool',
  'test_tool',
  'manage_tool',
  'invoke_tool',
]);
const AUTHOR_TOOL_NAMES = new Set(['inspect_tools', 'define_tool', 'test_tool']);
const TOOL_SOURCE_HISTORY_NOTICE =
  'The full source and Tool declarations were accepted and intentionally redacted from model history. Reuse your original complete arguments for a new define_tool call; these summary fields are not define_tool input.';
const ESM_HANDLER_EXAMPLE =
  'export default { HandlerName: async (args, context) => ({ ok: true }) };';
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

const jsonSchema = z.record(z.string(), z.unknown());
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
const defineInput = z.object({
  id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  source: z
    .string()
    .min(1)
    .max(256 * 1024),
  tools: z.array(toolDeclaration).min(1).max(64),
  permissions: z.object({
    workspace: z.enum(['none', 'read', 'write']),
    network: z.boolean(),
  }),
  ...extensionMetadata,
});
const revisionInput = z.object({
  extensionId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
});
const testInput = revisionInput.extend({
  toolName: z.string().min(1).max(128),
  args: z.unknown(),
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
const invokeInput = z.object({
  toolName: z.string().min(1).max(128),
  args: z.unknown(),
});

/** Host-owned Agent surface for authoring and operating the same packages humans install. */
export class HostToolPackageManagementTools {
  readonly #draftRoot: string;
  readonly #connection: ConnectionContext = {
    hostEpoch: 'internal-tool-package-management',
    connectionId: 'internal-agent-tool',
    surface: 'activation',
    principal: 'runtime_host',
    acquireResidency: () => ({ release: () => undefined }),
  };

  constructor(
    controlDirectory: string,
    private readonly controller: HostExtensionController,
    private readonly runtime: HostExtensionRuntime,
    private readonly store: ToolPackageStore,
  ) {
    this.#draftRoot = join(controlDirectory, 'tool-package-drafts-v1');
  }

  tools(): readonly MakaTool[] {
    return Object.freeze([
      this.#inspectTool(),
      this.#defineTool(),
      this.#testTool(),
      this.#manageTool(),
      this.#invokeTool(),
    ]);
  }

  /** Safe child-authoring subset: install and test candidates without binding or deleting them. */
  authorTools(): readonly MakaTool[] {
    return Object.freeze(this.tools().filter((tool) => AUTHOR_TOOL_NAMES.has(tool.name)));
  }

  #inspectTool(): MakaTool {
    return Object.freeze({
      name: 'inspect_tools',
      description:
        'Inspect installed Tool package revisions and active, failed, waiting, or disabled bindings before defining or changing a Tool.',
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

  #defineTool(): MakaTool {
    return Object.freeze({
      name: 'define_tool',
      description: `Validate, seal, and install a prebuilt JavaScript Tool package draft. Source must be an ES module with one default handler object, for example: ${ESM_HANDLER_EXAMPLE} CommonJS module.exports/exports is unsupported. A successful call installs an immutable revision but does not activate it; call test_tool and then manage_tool. Model history intentionally replaces the full source and Tool declarations with an accepted/redacted summary; that summary does not mean arguments were missing.`,
      parameters: defineInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (args: z.infer<typeof defineInput>) => ({
        id: args.id,
        version: args.version,
        sourceAccepted: true,
        sourceBytes: Buffer.byteLength(args.source, 'utf8'),
        sourceSha256: createHash('sha256').update(args.source).digest('hex'),
        toolDeclarationsAccepted: true,
        toolCount: args.tools.length,
        toolNames: args.tools.map(({ name }: { name: string }) => name),
        permissions: args.permissions,
        historyProjectionNotice: TOOL_SOURCE_HISTORY_NOTICE,
      }),
      impl: async (input: z.infer<typeof defineInput>) => {
        assertSupportedToolSource(input.source);
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(join(draft, 'dist'), { recursive: true, mode: 0o700 });
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
                runtime: {
                  entry: 'dist/index.mjs',
                  tools: input.tools,
                  events: [],
                  listeners: [],
                  services: [],
                  timers: [],
                  permissions: input.permissions,
                },
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

  #testTool(): MakaTool {
    return Object.freeze({
      name: 'test_tool',
      description:
        'Run one installed trusted Tool revision in the Runtime Host process without publishing it to the session Tool catalog.',
      parameters: testInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (args: z.infer<typeof testInput>) => args,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof testInput>, context: MakaToolContext) => {
        const installed = await this.store.load(input.extensionId, input.revision);
        const activation = new InProcessPackageActivation(installed);
        try {
          await activation.healthCheck(installed.manifest.tools.map(({ handler }) => handler));
          const tool = activation.tools().find(({ name }) => name === input.toolName);
          if (!tool) throw new Error(`Tool package does not declare Tool: ${input.toolName}`);
          await validateArgs(tool, input.args);
          return await tool.impl(input.args, context);
        } finally {
          await activation.dispose();
        }
      },
    });
  }

  #manageTool(): MakaTool {
    return Object.freeze({
      name: 'manage_tool',
      description:
        'Activate, update, stop, or delete a Tool package for the current session. Activation persists with the session until stopped. Successful activate/update results include the exact Tool declarations and inputSchema to use with invoke_tool.',
      parameters: manageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (args: z.infer<typeof manageInput>) => args,
      impl: async (input: z.infer<typeof manageInput>, context: MakaToolContext) => {
        const bindingId = bindingIdFor(context.sessionId, input.extensionId);
        switch (input.action) {
          case 'activate': {
            const revision = requireRevision(input);
            const result = unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                {
                  kind: 'enable',
                  bindingId,
                  scopeId: context.sessionId,
                  extensionId: input.extensionId,
                  revision,
                },
                this.#connection,
              ),
            );
            return this.#withToolDeclarations(result, input.extensionId, revision);
          }
          case 'update': {
            const revision = requireRevision(input);
            const result = unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                { kind: 'update', bindingId, revision },
                this.#connection,
              ),
            );
            return this.#withToolDeclarations(result, input.extensionId, revision);
          }
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

  async #withToolDeclarations(
    result: ExtensionCatalogMutateResult,
    extensionId: string,
    revision: string,
  ): Promise<Record<string, unknown>> {
    const installed = await this.store.load(extensionId, revision);
    return {
      ...result,
      tools: installed.manifest.tools.map((tool) => ({
        name: tool.name,
        ...(tool.displayName ? { displayName: tool.displayName } : {}),
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema),
        ...(tool.visualization ? { visualization: tool.visualization } : {}),
      })),
    };
  }

  #invokeTool(): MakaTool {
    return Object.freeze({
      name: 'invoke_tool',
      description:
        'Immediately invoke an active session Tool by name after manage_tool activation, including within the same model turn before native schemas refresh.',
      parameters: invokeInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (args: z.infer<typeof invokeInput>) => args,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof invokeInput>, context: MakaToolContext) => {
        if (MANAGEMENT_TOOL_NAMES.has(input.toolName)) {
          throw new Error(`Tool management Tools cannot be invoked recursively: ${input.toolName}`);
        }
        const ownership = this.runtime
          .inspectTools(context.sessionId)
          .find(({ toolName }) => toolName === input.toolName);
        const tool = this.runtime
          .resolveTools(context.sessionId, [])
          .find(({ name }) => name === input.toolName);
        if (!tool) throw new Error(`Active session Tool was not found: ${input.toolName}`);
        await validateArgs(tool, input.args);
        const result = await tool.impl(input.args, context);
        if (ownership) {
          const installed = await this.store.load(ownership.extensionId, ownership.revision);
          const stateKey = installed.manifest.tools.find(({ name }) => name === input.toolName)
            ?.visualization?.stateKey;
          const contribution = stateKey
            ? this.runtime
                .inspectUi('desktop-ui')
                .find(
                  (item) =>
                    item.extensionId === ownership.extensionId &&
                    item.revision === ownership.revision &&
                    item.hostState,
                )
            : undefined;
          if (stateKey && contribution) {
            unwrap(
              await this.controller.handlers['extension.ui.state.mutate'](
                {
                  scopeId: 'desktop-ui',
                  bindingId: contribution.bindingId,
                  extensionId: contribution.extensionId,
                  revision: contribution.revision,
                  key: stateKey,
                  kind: 'set',
                  value: result as ExtensionUiStateValue,
                },
                this.#connection,
              ),
            );
          }
        }
        return result;
      },
    });
  }
}

function assertSupportedToolSource(source: string): void {
  if (/\bmodule\s*\.\s*exports\b|\bexports\s*(?:\.|\[)/u.test(source)) {
    throw new Error(
      `Tool package source must use ESM; CommonJS module.exports/exports is unsupported. Use: ${ESM_HANDLER_EXAMPLE}`,
    );
  }
  if (!/\bexport\s+default\b/u.test(source)) {
    throw new Error(
      `Tool package source must export one default handler object. Use: ${ESM_HANDLER_EXAMPLE}`,
    );
  }
}

function requireRevision(input: z.infer<typeof manageInput>): string {
  if (input.revision === undefined) {
    throw new Error(`revision is required for ${input.action}`);
  }
  return input.revision;
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

function bindingIdFor(sessionId: string, extensionId: string): string {
  const digest = createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(extensionId)
    .digest('hex');
  return `agent_tool_${digest.slice(0, 32)}`;
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
