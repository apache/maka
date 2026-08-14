import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type {
  ExtensionCatalogQueryResult,
  OperationKey,
  OperationOutcome,
} from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import type { HostExtensionController } from './extension-controller.js';
import type { HostExtensionRuntime } from './extension-runtime.js';
import { ToolPackageActivation } from './tool-package-worker.js';
import { ToolPackageStore } from './tool-package-store.js';

const MANAGEMENT_TOOL_NAMES = new Set([
  'inspect_tools',
  'define_tool',
  'test_tool',
  'manage_tool',
  'invoke_tool',
]);
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
const toolDeclaration = z.object({
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(4096),
  handler: z.string().min(1).max(128),
  inputSchema: jsonSchema,
  displayName: z.string().min(1).max(128).optional(),
  category: z.enum(CATEGORIES).optional(),
  recoveryMode: z.enum(RECOVERY_MODES).optional(),
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
});
const revisionInput = z.object({
  extensionId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
});
const testInput = revisionInput.extend({
  toolName: z.string().min(1).max(128),
  args: z.unknown(),
});
const manageInput = z.discriminatedUnion('action', [
  revisionInput.extend({ action: z.literal('activate') }),
  revisionInput.extend({ action: z.literal('update') }),
  z.object({ action: z.literal('stop'), extensionId: z.string().min(1).max(128) }),
  revisionInput.extend({ action: z.literal('delete') }),
]);
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

  #inspectTool(): MakaTool {
    return Object.freeze({
      name: 'inspect_tools',
      description:
        'Inspect installed Tool package revisions and active, failed, waiting, or disabled bindings before defining or changing a Tool.',
      parameters: z.object({}),
      categoryHint: 'read',
      recoveryMode: 'replay_safe',
      impl: async (): Promise<ExtensionCatalogQueryResult> =>
        unwrap(await this.controller.handlers['extension.catalog.query']({}, this.#connection)),
    });
  }

  #defineTool(): MakaTool {
    return Object.freeze({
      name: 'define_tool',
      description:
        'Validate, seal, and install a prebuilt JavaScript Tool package draft. This does not activate it; call test_tool and then manage_tool.',
      parameters: defineInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (args: z.infer<typeof defineInput>) => ({
        id: args.id,
        version: args.version,
        toolNames: args.tools.map(({ name }: { name: string }) => name),
        permissions: args.permissions,
      }),
      impl: async (input: z.infer<typeof defineInput>) => {
        const draft = join(this.#draftRoot, randomUUID());
        try {
          await mkdir(join(draft, 'dist'), { recursive: true, mode: 0o700 });
          await writeFile(
            join(draft, 'maka.tool.json'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                id: input.id,
                version: input.version,
                entry: 'dist/index.mjs',
                tools: input.tools,
                permissions: input.permissions,
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
        'Run one installed Tool revision in its real isolated sandbox without publishing it to the session Tool catalog.',
      parameters: testInput,
      categoryHint: 'shell_unsafe',
      recoveryMode: 'never_auto_retry',
      permissionArgs: (args: z.infer<typeof testInput>) => args,
      executionFacts: managementExecutionFacts(),
      impl: async (input: z.infer<typeof testInput>, context: MakaToolContext) => {
        const installed = await this.store.load(input.extensionId, input.revision);
        const activation = new ToolPackageActivation(installed);
        try {
          await activation.healthCheck();
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
        'Activate, update, stop, or delete a Tool package for the current session. Activation persists with the session until stopped.',
      parameters: manageInput,
      categoryHint: 'file_write',
      recoveryMode: 'idempotent',
      permissionArgs: (args: z.infer<typeof manageInput>) => args,
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
                  revision: input.revision,
                },
                this.#connection,
              ),
            );
          case 'update':
            return unwrap(
              await this.controller.handlers['extension.catalog.mutate'](
                { kind: 'update', bindingId, revision: input.revision },
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
                { extensionId: input.extensionId, revision: input.revision },
                this.#connection,
              ),
            );
          }
        }
      },
    });
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
        const tool = this.runtime
          .resolveTools(context.sessionId, [])
          .find(({ name }) => name === input.toolName);
        if (!tool) throw new Error(`Active session Tool was not found: ${input.toolName}`);
        await validateArgs(tool, input.args);
        return tool.impl(input.args, context);
      },
    });
  }
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
    isolation: 'container',
    writesAffectHost: true,
    writeBack: 'direct',
    network: 'sandbox',
    secrets: 'none',
  });
}
