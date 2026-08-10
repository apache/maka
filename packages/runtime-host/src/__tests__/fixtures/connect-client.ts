import { connectOrSpawnRuntimeHostWithDependencies } from '../../client/connect-or-spawn.js';
import { launchDetachedRuntimeHostCandidate } from '../../client/launcher.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ClientSurface,
} from '../../protocol/index.js';

const [rootPath, surface] = process.argv.slice(2);
if (!rootPath || !isClientSurface(surface)) {
  throw new Error('usage: connect-client <root> <desktop|tui>');
}

const candidatePids: number[] = [];
const candidateEntrypoint = new URL('./kernel-candidate.js', import.meta.url);
const result = await connectOrSpawnRuntimeHostWithDependencies(
  {
    rootPath,
    surface,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint,
    electionDeadlineMs: 5_000,
  },
  {
    random: Math.random,
    launchCandidate: (input) => {
      const launch = launchDetachedRuntimeHostCandidate({ ...input, idleGraceMs: 200 });
      return {
        spawned: launch.spawned.then((attempt) => {
          candidatePids.push(attempt.pid);
          return attempt;
        }),
      };
    },
  },
);
if (result.kind !== 'connected') {
  throw new Error(`connect-client failed to connect: ${result.kind}`);
}

process.send?.({
  type: 'connected',
  hostEpoch: result.connection.hostEpoch,
  candidatePids,
});

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void result.connection.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.on('message', (message) => {
  if (message === 'close') close();
});
process.once('disconnect', close);

function isClientSurface(value: string | undefined): value is ClientSurface {
  return value === 'desktop' || value === 'tui' || value === 'capability-provider';
}
