import { once } from 'node:events';
import { startLocalIpcRuntimeHostListener } from '../../server/local-ipc-listener.js';

if (process.platform !== 'win32') {
  throw new Error('Windows Local IPC trust fixture must run on Windows');
}

const listener = await startLocalIpcRuntimeHostListener({
  rootId: 'ab'.repeat(32),
  hostEpoch: `trust-${process.pid}`,
  accept(connection) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'accepted',
        principalKind: connection.authority.principalKind,
      })}\n`,
    );
    connection.transport.abort();
  },
});

process.stdout.write(`${JSON.stringify({ type: 'ready', endpoint: listener.endpoint })}\n`);
process.stdin.resume();
await once(process.stdin, 'data');
process.stdin.pause();
await listener.closeAdmission();
await listener.cleanup();
