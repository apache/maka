import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  openRuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
} from '../client/ssh-tunnel.js';

const TUNNEL_INPUT = {
  destination: 'operator@example.com',
  remotePort: 7443,
  websocketPath: '/runtime-host',
  interaction: 'batch',
} as const satisfies RuntimeHostSshTunnelInput;

test('opens an exact loopback forward and owns the SSH process lifetime', async () => {
  let resolveExit:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | undefined;
  let launch: { executable: string; args: readonly string[]; interaction: string } | undefined;
  const spawnProcess: RuntimeHostSshProcessFactory = (input) => {
    launch = input;
    const forwarding = input.args[input.args.indexOf('-L') + 1];
    const localPort = Number(forwarding?.split(':')[1]);
    const logPath = input.args[input.args.indexOf('-E') + 1];
    assert.ok(logPath);
    void writeFile(logPath, `debug1: Local forwarding listening on 127.0.0.1 port ${localPort}.\n`);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        resolveExit = resolve;
      },
    );
    return {
      exited,
      kill: (signal) => {
        resolveExit?.({ code: null, signal });
      },
    } satisfies RuntimeHostSshProcess;
  };

  const tunnel = await openRuntimeHostSshTunnel(
    {
      ...TUNNEL_INPUT,
      sshPort: 2222,
    },
    { spawnProcess, readConfiguration: async () => '' },
  );
  assert.equal(launch?.executable, 'ssh');
  assert.equal(launch?.interaction, 'batch');
  assert.ok(launch?.args.includes('BatchMode=yes'));
  assert.ok(launch?.args.includes('ControlMaster=no'));
  assert.ok(launch?.args.includes('ControlPath=none'));
  assert.ok(launch?.args.includes('ClearAllForwardings=no'));
  assert.deepEqual(launch?.args.slice(-3), ['-p', '2222', 'operator@example.com']);
  assert.match(
    launch?.args[launch.args.indexOf('-L') + 1] ?? '',
    /^127\.0\.0\.1:\d+:127\.0\.0\.1:7443$/u,
  );
  assert.match(tunnel.url, /^ws:\/\/127\.0\.0\.1:\d+\/runtime-host$/u);

  await tunnel.resource.close();
  await tunnel.resource.closed;
});

test('retries a confirmed local forwarding bind conflict', async () => {
  let attempts = 0;
  let resolveExit:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | undefined;
  const tunnel = await openRuntimeHostSshTunnel(TUNNEL_INPUT, {
    readConfiguration: async () => '',
    spawnProcess: (input) => {
      attempts += 1;
      const forwarding = input.args[input.args.indexOf('-L') + 1];
      const localPort = Number(forwarding?.split(':')[1]);
      const logPath = input.args[input.args.indexOf('-E') + 1];
      assert.ok(logPath);
      if (attempts === 1) {
        return {
          exited: writeFile(
            logPath,
            `bind [127.0.0.1]:${localPort}: Address already in use\n`,
          ).then(() => ({ code: 255, signal: null })),
          kill: () => undefined,
        };
      }
      void writeFile(
        logPath,
        `debug1: Local forwarding listening on 127.0.0.1 port ${localPort}.\n`,
      );
      return {
        exited: new Promise((resolve) => {
          resolveExit = resolve;
        }),
        kill: (signal) => resolveExit?.({ code: null, signal }),
      };
    },
  });
  assert.equal(attempts, 2);
  await tunnel.resource.close();
});

test('explains how a non-interactive SSH connection can be prepared', async () => {
  let attempts = 0;
  await assert.rejects(
    openRuntimeHostSshTunnel(TUNNEL_INPUT, {
      readConfiguration: async () => '',
      spawnProcess: (input) => {
        attempts += 1;
        const forwarding = input.args[input.args.indexOf('-L') + 1];
        const localPort = Number(forwarding?.split(':')[1]);
        const unrelatedPort = localPort === 65_535 ? localPort - 1 : localPort + 1;
        const logPath = input.args[input.args.indexOf('-E') + 1];
        assert.ok(logPath);
        return {
          exited: writeFile(
            logPath,
            `bind [127.0.0.1]:${unrelatedPort}: Address already in use\n`,
          ).then(() => ({ code: 255, signal: null })),
          kill: () => undefined,
        };
      },
    }),
    /Configure OpenSSH host verification and key or agent authentication/u,
  );
  assert.equal(attempts, 1);
});

test('rejects inherited OpenSSH forwarding before starting a tunnel', async () => {
  let spawned = false;
  await assert.rejects(
    openRuntimeHostSshTunnel(TUNNEL_INPUT, {
      readConfiguration: async () =>
        'hostname example.com\nlocalforward [0.0.0.0]:43002 [127.0.0.1]:22\n',
      spawnProcess: () => {
        spawned = true;
        throw new Error('unreachable');
      },
    }),
    /configures additional port forwarding/u,
  );
  assert.equal(spawned, false);
});
