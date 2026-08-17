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
import type { InstalledToolPackage, ToolPackageManifest } from './tool-package-store.js';
import {
  ToolPackageActivation,
  type PackageWorkerEventEmitter,
  type PackageWorkerServiceCaller,
} from './tool-package-worker.js';
import type { InstalledEventPackage } from './event-package-store.js';

/** One Event Extension activation backed by isolated one-shot Listener workers. */
export class EventPackageActivation {
  constructor(
    readonly packageRevision: InstalledEventPackage,
    readonly configuration: Readonly<Record<string, string | number | boolean>> = Object.freeze({}),
    private readonly emitEvent?: PackageWorkerEventEmitter,
    private readonly callService?: PackageWorkerServiceCaller,
  ) {}

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
          invoke: (payload: unknown, context: ExtensionEventInvocationContext) =>
            this.#invoke(declaration.handler, declaration.timeoutMs, payload, context),
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
            return this.#invokeService(definition.handler, definition.timeoutMs, input, context);
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
            this.#invokeTimer(timer.handler, timer.timeoutMs, payload, context),
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
    const worker = this.#newWorker();
    try {
      await worker.healthCheck();
    } finally {
      await worker.dispose();
    }
  }

  async dispose(): Promise<void> {
    // Listener workers are one-shot. In-flight immutable Revision snapshots own their invocation.
  }

  async #invoke(
    handler: string,
    timeoutMs: number,
    payload: unknown,
    context: ExtensionEventInvocationContext,
  ): Promise<unknown> {
    const worker = this.#newWorker();
    try {
      const result = await worker.invokeRaw(
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
        timeoutMs,
      );
      return result;
    } finally {
      await worker.dispose();
    }
  }

  async #invokeService(
    handler: string,
    timeoutMs: number,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ): Promise<unknown> {
    const worker = this.#newWorker();
    try {
      return await worker.invokeRaw(
        handler,
        input,
        {
          sessionId: context.sessionId,
          ...(context.runId ? { runId: context.runId } : {}),
          turnId: context.turnId,
          cwd: context.cwd,
          toolCallId: `service:${handler}`,
          abortSignal: context.signal,
          permissionMode: context.permissionMode,
          origin: context.origin,
          serviceDepth: context.serviceDepth,
        },
        timeoutMs,
      );
    } finally {
      await worker.dispose();
    }
  }

  async #invokeTimer(
    handler: string,
    timeoutMs: number,
    payload: unknown,
    context: ExtensionTimerInvocationContext,
  ): Promise<unknown> {
    const worker = this.#newWorker();
    try {
      return await worker.invokeRaw(
        handler,
        payload,
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          cwd: context.cwd,
          toolCallId: `timer:${handler}:${context.scheduledAt}`,
          abortSignal: context.signal,
          permissionMode: context.permissionMode,
          origin: context.origin,
        },
        timeoutMs,
      );
    } finally {
      await worker.dispose();
    }
  }

  #newWorker(): ToolPackageActivation {
    return new ToolPackageActivation(
      asToolPackage(this.packageRevision),
      this.configuration,
      {
        MAKA_EVENT_LISTENER_ACTIVE: '1',
      },
      this.emitEvent,
      this.callService,
    );
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
