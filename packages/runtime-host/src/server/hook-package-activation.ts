import type {
  ExtensionHookContribution,
  ExtensionHookInvocationContext,
  ExtensionHookInvocationResult,
} from '@maka/runtime/extension-hook-contributions';
import type { InstalledToolPackage, ToolPackageManifest } from './tool-package-store.js';
import { ToolPackageActivation } from './tool-package-worker.js';
import type { InstalledHookPackage } from './hook-package-store.js';

const MAX_REASON_BYTES = 4_096;

/** One Hook Extension activation backed by the same one-shot OS sandbox as Tool packages. */
export class HookPackageActivation {
  constructor(
    readonly packageRevision: InstalledHookPackage,
    readonly configuration: Readonly<Record<string, string | number | boolean>> = Object.freeze({}),
  ) {}

  contributions(): readonly ExtensionHookContribution[] {
    return Object.freeze(
      this.packageRevision.manifest.hooks.map((declaration) =>
        Object.freeze({
          ...declaration,
          invoke: (payload: unknown, context: ExtensionHookInvocationContext) =>
            this.#invoke(
              declaration.handler,
              declaration.timeoutMs,
              declaration.mode,
              payload,
              context,
            ),
        }),
      ),
    );
  }

  async healthCheck(): Promise<void> {
    const worker = this.#newWorker();
    try {
      await worker.healthCheck();
    } finally {
      await worker.dispose();
    }
  }

  async dispose(): Promise<void> {
    // Invocations are one-shot and own their worker. Captured Turn snapshots
    // may continue to invoke this immutable Revision after registry removal.
  }

  async #invoke(
    handler: string,
    timeoutMs: number,
    mode: 'observe' | 'gate' | 'transform',
    payload: unknown,
    context: ExtensionHookInvocationContext,
  ): Promise<ExtensionHookInvocationResult | undefined> {
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
          toolCallId: `hook:${handler}`,
          abortSignal: context.signal,
        },
        timeoutMs,
      );
      return decodeResult(result, mode);
    } finally {
      await worker.dispose();
    }
  }

  #newWorker(): ToolPackageActivation {
    return new ToolPackageActivation(asToolPackage(this.packageRevision), this.configuration, {
      MAKA_HOOK_ACTIVE: '1',
    });
  }
}

function asToolPackage(installed: InstalledHookPackage): InstalledToolPackage {
  const manifest: ToolPackageManifest = Object.freeze({
    schemaVersion: 1,
    id: installed.extensionId,
    version: installed.manifest.version,
    entry: installed.manifest.entry,
    tools: Object.freeze(
      installed.manifest.hooks.map((hook) =>
        Object.freeze({
          name: hook.id,
          description: `${hook.event} Hook`,
          handler: hook.handler,
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

function decodeResult(
  value: unknown,
  mode: 'observe' | 'gate' | 'transform',
): ExtensionHookInvocationResult | undefined {
  if (value === null || value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hook handler result must be an object or null');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['decision', 'reason', 'payload'].includes(key))) {
    throw new Error('Hook handler result contains unknown fields');
  }
  if (record.decision !== undefined && record.decision !== 'allow' && record.decision !== 'deny') {
    throw new Error('Hook handler decision must be allow or deny');
  }
  if (
    record.reason !== undefined &&
    (typeof record.reason !== 'string' ||
      Buffer.byteLength(record.reason, 'utf8') > MAX_REASON_BYTES)
  ) {
    throw new Error('Hook handler reason is invalid');
  }
  if (mode === 'observe' && Object.keys(record).length > 0) {
    throw new Error('Observe Hook handlers must not return a decision or replacement payload');
  }
  if (mode === 'gate' && Object.hasOwn(record, 'payload')) {
    throw new Error('Gate Hook handlers must not return a replacement payload');
  }
  if (mode === 'transform' && record.decision !== undefined) {
    throw new Error('Transform Hook handlers must not return a decision');
  }
  return Object.freeze({
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(Object.hasOwn(record, 'payload') ? { payload: structuredClone(record.payload) } : {}),
  });
}
