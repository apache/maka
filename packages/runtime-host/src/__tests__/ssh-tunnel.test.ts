import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { test } from 'node:test';
import {
  openRuntimeHostSshTunnel,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
} from '../client/ssh-tunnel.js';

test('opens an exact loopback forward and owns the SSH process lifetime', async () => {
  let server: Server | undefined;
  let resolveExit:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | undefined;
  let launch: { executable: string; args: readonly string[]; interaction: string } | undefined;
  const spawnProcess: RuntimeHostSshProcessFactory = (input) => {
    launch = input;
    const forwarding = input.args[input.args.indexOf('-L') + 1];
    const localPort = Number(forwarding?.split(':')[1]);
    server = createServer();
    server.listen(localPort, '127.0.0.1');
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        resolveExit = resolve;
      },
    );
    return {
      exited,
      kill: (signal) => {
        server?.close(() => resolveExit?.({ code: null, signal }));
      },
    } satisfies RuntimeHostSshProcess;
  };

  const tunnel = await openRuntimeHostSshTunnel(
    {
      destination: 'operator@example.com',
      sshPort: 2222,
      remotePort: 7443,
      websocketPath: '/runtime-host',
      interaction: 'batch',
    },
    { spawnProcess },
  );
  assert.equal(launch?.executable, 'ssh');
  assert.equal(launch?.interaction, 'batch');
  assert.ok(launch?.args.includes('BatchMode=yes'));
  assert.deepEqual(launch?.args.slice(-3), ['-p', '2222', 'operator@example.com']);
  assert.match(
    launch?.args[launch.args.indexOf('-L') + 1] ?? '',
    /^127\.0\.0\.1:\d+:127\.0\.0\.1:7443$/u,
  );
  assert.match(tunnel.url, /^ws:\/\/127\.0\.0\.1:\d+\/runtime-host$/u);

  await tunnel.resource.close();
  await tunnel.resource.closed;
  assert.equal(server?.listening, false);
});

test('explains how a non-interactive SSH connection can be prepared', async () => {
  await assert.rejects(
    openRuntimeHostSshTunnel(
      {
        destination: 'operator@example.com',
        remotePort: 7443,
        websocketPath: '/runtime-host',
        interaction: 'batch',
      },
      {
        spawnProcess: () => ({
          exited: Promise.resolve({ code: 255, signal: null }),
          kill: () => undefined,
        }),
      },
    ),
    /Configure OpenSSH host verification and key or agent authentication/u,
  );
});
