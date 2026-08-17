import type {
  ExtensionEventDefinition,
  ExtensionEventInvocationContext,
  ExtensionEventListenerContribution,
} from '@maka/runtime/extension-event-contributions';
import type { InstalledToolPackage, ToolPackageManifest } from './tool-package-store.js';
import { ToolPackageActivation, type PackageWorkerEventEmitter } from './tool-package-worker.js';
import type { InstalledEventPackage } from './event-package-store.js';

/** One Event Extension activation backed by isolated one-shot Listener workers. */
export class EventPackageActivation {
  constructor(
    readonly packageRevision: InstalledEventPackage,
    readonly configuration: Readonly<Record<string, string | number | boolean>> = Object.freeze({}),
    private readonly emitEvent?: PackageWorkerEventEmitter,
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

  async healthCheck(): Promise<void> {
    if (this.packageRevision.manifest.listeners.length === 0) return;
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
  ): Promise<void> {
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
      if (result !== null && result !== undefined) {
        throw new Error('Event Listener handlers must not return a value');
      }
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
    );
  }
}

function asToolPackage(installed: InstalledEventPackage): InstalledToolPackage {
  const manifest: ToolPackageManifest = Object.freeze({
    schemaVersion: 1,
    id: installed.extensionId,
    version: installed.manifest.version,
    entry: installed.manifest.entry,
    tools: Object.freeze(
      installed.manifest.listeners.map((listener) =>
        Object.freeze({
          name: listener.id,
          description: `${listener.event} Event Listener`,
          handler: listener.handler,
          inputSchema: Object.freeze({}),
          recoveryMode: 'never_auto_retry' as const,
        }),
      ),
    ),
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
