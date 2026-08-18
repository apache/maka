import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ExtensionConfigurationScalar } from '../protocol/extension.js';
import type { InstalledToolPackage } from './plugin-runtime-manifest.js';

export interface PackageInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly operationId?: string;
  readonly abortSignal: AbortSignal;
  readonly permissionMode?: string;
  readonly origin?: 'provider' | 'code_mode' | 'host';
  readonly eventDepth?: number;
  readonly serviceDepth?: number;
  readonly emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export type PackageEventEmitter = (
  event: string,
  payload: unknown,
  context: PackageInvocationContext,
) => Promise<unknown>;

export type PackageServiceCaller = (
  service: string,
  method: string,
  input: unknown,
  context: PackageInvocationContext & { readonly callerExtensionId: string },
) => Promise<unknown>;

export type PackageContinuation = (value?: unknown) => unknown | Promise<unknown>;

type PackageHandler = (
  value: unknown,
  context: Readonly<
    PackageInvocationContext & {
      readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
      readonly emitEvent: (event: string, payload: unknown) => Promise<unknown>;
      readonly callService: (service: string, method: string, input: unknown) => Promise<unknown>;
    }
  >,
  next?: PackageContinuation,
) => unknown | Promise<unknown>;

interface PackageModule {
  readonly default?: unknown;
  readonly tools?: unknown;
}

export class InProcessPackageError extends Error {
  readonly name = 'InProcessPackageError';

  constructor(
    readonly code: 'load_failed' | 'handler_missing' | 'aborted' | 'retired',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * One trusted in-process Extension activation.
 *
 * Package code has the same security authority as the Runtime Host. The public
 * context is a cooperative API and not a sandbox boundary. A module is loaded
 * once for the activation and all contribution calls share its live state.
 */
export class InProcessPackageActivation {
  readonly #invocations = new Set<Promise<unknown>>();
  #handlersTask: Promise<Readonly<Record<string, PackageHandler>>> | undefined;

  constructor(
    readonly packageRevision: InstalledToolPackage,
    readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>> = Object.freeze(
      {},
    ),
    private readonly emitEvent?: PackageEventEmitter,
    private readonly callService?: PackageServiceCaller,
  ) {}

  tools(): readonly MakaTool[] {
    return Object.freeze(
      this.packageRevision.manifest.tools.map((declaration) => {
        let parameters: unknown;
        try {
          parameters = z.fromJSONSchema(declaration.inputSchema);
        } catch (error) {
          throw new InProcessPackageError(
            'load_failed',
            `Tool package JSON Schema is unsupported: ${declaration.name}`,
            { cause: error },
          );
        }
        return Object.freeze({
          name: declaration.name,
          description: declaration.description,
          parameters,
          ...(declaration.displayName ? { displayName: declaration.displayName } : {}),
          categoryHint: effectiveCategory(this.packageRevision.manifest, declaration.category),
          recoveryMode: declaration.recoveryMode ?? 'never_auto_retry',
          executionFacts: executionFacts(this.packageRevision.manifest),
          permissionArgs: (args: unknown) => args,
          impl: (args: unknown, context: MakaToolContext) =>
            this.invoke(declaration.handler, args, context),
        } satisfies MakaTool);
      }),
    );
  }

  async healthCheck(handlers: readonly string[]): Promise<void> {
    this.#assertActive();
    const loaded = await this.#handlers();
    for (const handler of handlers) requireHandler(loaded, handler);
  }

  invoke(handler: string, args: unknown, context: MakaToolContext): Promise<unknown> {
    return this.invokeRaw(handler, args, context);
  }

  invokeRaw(
    handler: string,
    value: unknown,
    context: PackageInvocationContext,
    next?: PackageContinuation,
  ): Promise<unknown> {
    this.#assertActive();
    if (context.abortSignal.aborted) {
      return Promise.reject(
        new InProcessPackageError('aborted', `Extension invocation was aborted: ${handler}`, {
          cause: context.abortSignal.reason,
        }),
      );
    }
    const invocation = this.#invoke(handler, value, context, next);
    this.#invocations.add(invocation);
    void invocation.then(
      () => this.#invocations.delete(invocation),
      () => this.#invocations.delete(invocation),
    );
    return invocation;
  }

  async dispose(): Promise<void> {
    // Registries stop exposing this activation before disposal. Captured Turn
    // snapshots intentionally retain their bound handlers and may still enter
    // after a Binding update; those live references are the generation lease.
    await Promise.allSettled([...this.#invocations]);
  }

  async #invoke(
    handlerName: string,
    value: unknown,
    context: PackageInvocationContext,
    next?: PackageContinuation,
  ): Promise<unknown> {
    const handler = requireHandler(await this.#handlers(), handlerName);
    const runtimeContext = Object.freeze({
      ...context,
      configuration: this.configuration,
      emitEvent: (event: string, payload: unknown) => {
        if (!this.emitEvent) throw new Error('Extension Event emission is unavailable');
        return this.emitEvent(event, payload, context);
      },
      callService: (service: string, method: string, input: unknown) => {
        if (!this.callService) throw new Error('Extension Service calls are unavailable');
        return this.callService(service, method, input, {
          ...context,
          callerExtensionId: this.packageRevision.extensionId,
        });
      },
    });
    const result = await handler(value, runtimeContext, next);
    if (context.abortSignal.aborted) {
      throw new InProcessPackageError(
        'aborted',
        `Extension invocation was aborted: ${handlerName}`,
        {
          cause: context.abortSignal.reason,
        },
      );
    }
    return result;
  }

  #handlers(): Promise<Readonly<Record<string, PackageHandler>>> {
    this.#assertActive();
    this.#handlersTask ??= loadHandlers(this.packageRevision.entry);
    return this.#handlersTask;
  }

  #assertActive(): void {
    // Authority is owned by the lifecycle registries. A captured contribution
    // is itself a lease and remains callable until its Turn releases the snapshot.
  }
}

async function loadHandlers(entry: string): Promise<Readonly<Record<string, PackageHandler>>> {
  let imported: PackageModule;
  try {
    const url = pathToFileURL(entry);
    url.searchParams.set('makaActivation', randomUUID());
    imported = (await import(url.href)) as PackageModule;
  } catch (error) {
    throw new InProcessPackageError('load_failed', `Unable to load Extension entry: ${entry}`, {
      cause: error,
    });
  }
  const handlers = imported.default ?? imported.tools;
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new InProcessPackageError(
      'load_failed',
      'Extension entry must export a default handler object',
    );
  }
  return handlers as Readonly<Record<string, PackageHandler>>;
}

function requireHandler(
  handlers: Readonly<Record<string, PackageHandler>>,
  name: string,
): PackageHandler {
  const handler = handlers[name];
  if (typeof handler !== 'function') {
    throw new InProcessPackageError('handler_missing', `Extension handler is missing: ${name}`);
  }
  return handler;
}

function effectiveCategory(
  manifest: InstalledToolPackage['manifest'],
  declared: InstalledToolPackage['manifest']['tools'][number]['category'],
): NonNullable<InstalledToolPackage['manifest']['tools'][number]['category']> {
  if (declared) return declared;
  if (manifest.permissions.workspace === 'write') return 'file_write';
  if (manifest.permissions.network) return 'network_send';
  return 'read';
}

function executionFacts(manifest: InstalledToolPackage['manifest']): MakaTool['executionFacts'] {
  return Object.freeze({
    isolation: 'none',
    writesAffectHost: manifest.permissions.workspace === 'write',
    writeBack: 'direct',
    network: manifest.permissions.network ? 'host' : 'disabled',
    secrets: 'host_env',
  });
}
