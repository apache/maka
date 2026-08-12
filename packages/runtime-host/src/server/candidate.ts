import { resolveExistingStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import type { RuntimeHostCompositionSource } from './host-composition.js';
import { RuntimeHostKernel } from './host-kernel.js';

export interface InteractiveRuntimeHostCandidateOptions {
  rootPath: string;
  expectedRootId: string;
  initialConnectionTimeoutMs?: number;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  generation?: string;
}

export type InteractiveRuntimeHostCandidateResult =
  | { kind: 'loser' }
  | { kind: 'winner'; host: RuntimeHostKernel };

export async function startInteractiveRuntimeHostCandidate(
  options: InteractiveRuntimeHostCandidateOptions,
  composition: RuntimeHostCompositionSource<'interactive'>,
): Promise<InteractiveRuntimeHostCandidateResult> {
  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: 'interactive',
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireStateRootOwner(capability);
  if (!owner) return { kind: 'loser' };
  const host = await RuntimeHostKernel.start({
    owner,
    lifecycleMode: 'ephemeral',
    initialConnectionTimeoutMs: options.initialConnectionTimeoutMs,
    idleGraceMs: options.idleGraceMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    generation: options.generation,
    composition,
  });
  return { kind: 'winner', host };
}
