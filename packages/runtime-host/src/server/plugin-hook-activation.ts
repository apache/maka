import type {
  ExtensionEventDefinition,
  ExtensionEventInvocationContext,
  ExtensionEventListenerContribution,
} from '@maka/runtime/extension-event-contributions';
import type {
  ExtensionServiceContribution,
  ExtensionServiceInvocationContext,
} from '@maka/runtime/extension-service-contributions';
import type {
  ExtensionTimerContribution,
  ExtensionTimerInvocationContext,
} from '@maka/runtime/extension-timer-contributions';
import type { InstalledToolPackage, ToolPackageManifest } from './plugin-runtime-manifest.js';
import {
  InProcessPackageActivation,
  type PackageContinuation,
  type PackageEventEmitter,
  type PackageServiceCaller,
} from './in-process-package-runtime.js';
import type { InstalledEventPackage } from './plugin-hook-manifest.js';

/** One trusted Hook plugin activation backed by a live in-process module. */
export class PluginHookActivation {
  readonly #runtime: InProcessPackageActivation;
  readonly #ownsRuntime: boolean;

  constructor(
    readonly packageRevision: InstalledEventPackage,
    readonly configuration: Readonly<Record<string, string | number | boolean>> = Object.freeze({}),
    emitEvent?: PackageEventEmitter,
    callService?: PackageServiceCaller,
    runtime?: InProcessPackageActivation,
  ) {
    this.#runtime =
      runtime ??
      new InProcessPackageActivation(
        asToolPackage(packageRevision),
        configuration,
        emitEvent,
        callService,
      );
    this.#ownsRuntime = runtime === undefined;
  }

  events(): readonly ExtensionEventDefinition[] {
    return Object.freeze(
      this.packageRevision.manifest.events.map((event) => Object.freeze({ ...event })),
    );
  }

  listeners(): readonly ExtensionEventListenerContribution[] {
    return Object.freeze(
      this.packageRevision.manifest.listeners.map((declaration) =>
        Object.freeze({
          ...declaration,
          invoke: (
            payload: unknown,
            context: ExtensionEventInvocationContext,
            next?: PackageContinuation,
          ) => this.#invoke(declaration.handler, payload, context, next),
        }),
      ),
    );
  }

  services(): readonly ExtensionServiceContribution[] {
    return Object.freeze(
      this.packageRevision.manifest.services.map((service) =>
        Object.freeze({
          ...service,
          invoke: (method: string, input: unknown, context: ExtensionServiceInvocationContext) => {
            const definition = service.methods.find((candidate) => candidate.name === method);
            if (!definition)
              throw new Error(`Service method is not declared: ${service.name}.${method}`);
            return this.#invokeService(definition.handler, input, context);
          },
        }),
      ),
    );
  }

  timers(): readonly ExtensionTimerContribution[] {
    return Object.freeze(
      this.packageRevision.manifest.timers.map((timer) =>
        Object.freeze({
          ...timer,
          configuration: this.configuration,
          invoke: (payload: unknown, context: ExtensionTimerInvocationContext) =>
            this.#invokeTimer(timer.handler, payload, context),
        }),
      ),
    );
  }

  async healthCheck(): Promise<void> {
    if (
      this.packageRevision.manifest.listeners.length === 0 &&
      this.packageRevision.manifest.services.length === 0 &&
      this.packageRevision.manifest.timers.length === 0
    )
      return;
    await this.#runtime.healthCheck([
      ...this.packageRevision.manifest.listeners.map(({ handler }) => handler),
      ...this.packageRevision.manifest.services.flatMap(({ methods }) =>
        methods.map(({ handler }) => handler),
      ),
      ...this.packageRevision.manifest.timers.map(({ handler }) => handler),
    ]);
  }

  async dispose(): Promise<void> {
    if (this.#ownsRuntime) await this.#runtime.dispose();
  }

  async #invoke(
    handler: string,
    payload: unknown,
    context: ExtensionEventInvocationContext,
    next?: PackageContinuation,
  ): Promise<unknown> {
    return await this.#runtime.invokeRaw(
      handler,
      payload,
      {
        sessionId: context.sessionId,
        ...(context.runId ? { runId: context.runId } : {}),
        turnId: context.turnId,
        cwd: context.cwd,
        toolCallId: `event-listener:${handler}`,
        abortSignal: context.signal,
        permissionMode: context.permissionMode,
        origin: context.origin,
        eventDepth: context.eventDepth,
      },
      next,
    );
  }

  async #invokeService(
    handler: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown> {
    return await this.#runtime.invokeRaw(handler, input, {
      sessionId: context.sessionId,
      ...(context.runId ? { runId: context.runId } : {}),
      turnId: context.turnId,
      cwd: context.cwd,
      toolCallId: `service:${handler}`,
      abortSignal: context.signal,
      permissionMode: context.permissionMode,
      origin: context.origin,
      serviceDepth: context.serviceDepth,
    });
  }

  async #invokeTimer(
    handler: string,
    payload: unknown,
    context: ExtensionTimerInvocationContext,
  ): Promise<unknown> {
    return await this.#runtime.invokeRaw(handler, payload, {
      sessionId: context.sessionId,
      turnId: context.turnId,
      cwd: context.cwd,
      toolCallId: `timer:${handler}:${context.scheduledAt}`,
      abortSignal: context.signal,
      permissionMode: context.permissionMode,
      origin: context.origin,
    });
  }
}

function asToolPackage(installed: InstalledEventPackage): InstalledToolPackage {
  const manifest: ToolPackageManifest = Object.freeze({
    schemaVersion: 1,
    id: installed.extensionId,
    version: installed.manifest.version,
    entry: installed.manifest.entry,
    tools: Object.freeze([
      ...installed.manifest.listeners.map((listener) =>
        Object.freeze({
          name: listener.id,
          description: `${listener.event} Event Listener`,
          handler: listener.handler,
          inputSchema: Object.freeze({}),
          recoveryMode: 'never_auto_retry' as const,
        }),
      ),
      ...installed.manifest.services.flatMap((service) =>
        service.methods.map((method) =>
          Object.freeze({
            name: `${service.name}.${method.name}`,
            description: method.description || `${service.name}.${method.name} Service method`,
            handler: method.handler,
            inputSchema: method.inputSchema,
            recoveryMode: 'never_auto_retry' as const,
          }),
        ),
      ),
      ...installed.manifest.timers.map((timer) =>
        Object.freeze({
          name: `timer.${timer.id}`,
          description: `${timer.id} Timer handler`,
          handler: timer.handler,
          inputSchema: Object.freeze({}),
          recoveryMode: 'never_auto_retry' as const,
        }),
      ),
    ]),
    permissions: installed.manifest.permissions,
  });
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    root: installed.root,
    entry: installed.entry,
    manifest,
  });
}
