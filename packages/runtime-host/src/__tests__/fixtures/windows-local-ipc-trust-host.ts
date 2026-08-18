import { once } from 'node:events';
import { startLocalIpcRuntimeHostListener } from '../../server/local-ipc-listener.js';
import type { RuntimeHostMessageTransport } from '../../transport/message-transport.js';

if (process.platform !== 'win32') {
  throw new Error('Windows Local IPC trust fixture must run on Windows');
}

const transports = new Set<RuntimeHostMessageTransport>();
const listener = await startLocalIpcRuntimeHostListener({
  rootId: 'ab'.repeat(32),
  hostEpoch: `trust-${process.pid}`,
  accept(connection) {
    transports.add(connection.transport);
    void connection.transport.closed.then(() => transports.delete(connection.transport));
    process.stdout.write(
      `${JSON.stringify({
        type: 'accepted',
        principalKind: connection.authority.principalKind,
      })}\n`,
    );
  },
});

process.stdout.write(`${JSON.stringify({ type: 'ready', endpoint: listener.endpoint })}\n`);
process.stdin.resume();
await once(process.stdin, 'data');
process.stdin.pause();
await Promise.all(
  [...transports].map((transport) => {
    transport.abort();
    return transport.closed;
  }),
);
await listener.closeAdmission();
await listener.cleanup();
