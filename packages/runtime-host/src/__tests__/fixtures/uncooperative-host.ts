import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { RuntimeHostKernel, type RuntimeHostComposition } from '../../server/host-kernel.js';
import { createUnavailableDomainOperationHandlers } from '../../server/operation-dispatcher.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const [rootPath, expectedRootId, shutdownGraceRaw] = process.argv.slice(2);
if (!rootPath || !expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
  throw new Error('usage: uncooperative-host <root> <expected-root-id> <shutdown-grace-ms>');
}
const shutdownGraceMs = Number(shutdownGraceRaw);
if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
  throw new Error('uncooperative-host requires a positive shutdown grace');
}

const capability = await resolveExistingStorageRoot({
  path: rootPath,
  kind: 'interactive',
  expectedRootId,
});
const owner = await tryAcquireInteractiveRootOwner(capability);
if (!owner) throw new Error('uncooperative-host could not acquire the Interactive root');

const host = await RuntimeHostKernel.start({
  owner,
  idleGraceMs: 60_000,
  shutdownGraceMs,
  compositionFactory: async (context): Promise<RuntimeHostComposition> => ({
    handlers: {
      ...createUnavailableDomainOperationHandlers(),
      'turn.start': async () => {
        context.acquireResidency();
        process.send?.({ type: 'operation-blocked' });
        return new Promise<never>(() => undefined);
      },
      'turn.query': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'turn.stop': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'turn.message.submit': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'queue.retract': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'turn.interrupt': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'interaction.query': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'interaction.answer': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'subscription.open': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'subscription.close': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
      'task.ledger.query': async () => ({
        ok: false,
        error: { code: 'operation_unavailable', message: 'Operation unavailable in test Host' },
      }),
    },
    beginDrain() {},
    async recover() {},
    async close() {},
  }),
});

process.on('message', (message: unknown) => {
  if (
    message &&
    typeof message === 'object' &&
    (message as { type?: unknown }).type === 'shutdown'
  ) {
    void host.close();
    process.send?.({ type: 'shutdown-requested' });
  }
});
process.send?.({ type: 'ready', hostEpoch: host.hostEpoch, endpoint: host.endpoint });

try {
  await runRuntimeHostProcessLifecycle(host, { closeOnDisconnect: true });
} catch {
  process.exitCode = 1;
}
