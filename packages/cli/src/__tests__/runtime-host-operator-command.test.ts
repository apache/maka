import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  resolveRuntimeHostAccessIssue,
  type RuntimeHostAccessIssueOptions,
} from '../runtime-host-access-command.js';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runRuntimeHostProjectCli } from '../runtime-host-project-command.js';
import { createRuntimeHostServiceReadyEvent } from '../runtime-host-service-command.js';

describe('Runtime Host operator commands', () => {
  test('parses project management and machine-readable service readiness', () => {
    assert.deepEqual(parseRuntimeHostCommand(['project', 'list', '--root', '/srv/maka']), {
      kind: 'runtime-host-project-list',
      rootPath: '/srv/maka',
    });
    assert.deepEqual(
      parseRuntimeHostCommand(['project', 'add', '/work/project', '--root', '/srv/maka']),
      {
        kind: 'runtime-host-project-add',
        rootPath: '/srv/maka',
        path: '/work/project',
      },
    );
    assert.deepEqual(parseRuntimeHostCommand(['serve', '--json']), {
      kind: 'runtime-host-serve',
      json: true,
    });
  });

  test('expands access presets without access administration or Host paths', () => {
    const desktop = resolveRuntimeHostAccessIssue(presetOptions('desktop-client'));
    const terminal = resolveRuntimeHostAccessIssue(presetOptions('terminal-client'));

    for (const resolved of [desktop, terminal]) {
      assert.equal(resolved.principalKind, 'remote_owner');
      assert.equal(resolved.canUseHostPaths, false);
      assert.equal(resolved.operationGrants.includes('access.credential.issue'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.revoke'), false);
      assert.equal(resolved.operationGrants.includes('host.upgrade.prepare'), false);
      assert.equal(resolved.operationGrants.includes('turn.start'), true);
      assert.equal(resolved.operationGrants.includes('project.catalog.query'), true);
    }
    assert.equal(desktop.canPublishClientCapabilities, true);
    assert.equal(desktop.operationGrants.includes('client.capability.replace'), true);
    assert.equal(terminal.canPublishClientCapabilities, false);
    assert.equal(terminal.operationGrants.includes('client.capability.replace'), false);
    assert.equal(
      parseRuntimeHostCommand([
        'access',
        'issue',
        '--principal',
        'desktop',
        '--preset',
        'desktop-client',
        '--grant',
        'turn.start',
      ]).kind,
      'error',
    );
  });

  test('emits bounded service identity and listener facts without credentials', () => {
    const event = createRuntimeHostServiceReadyEvent({
      rootId: 'a'.repeat(64),
      hostEpoch: 'epoch-1',
      endpoint: '/tmp/maka.sock',
      websocketEndpoints: ['wss://0.0.0.0:7443/runtime-host'],
      compositionDescriptor: { id: 'maka.interactive', revision: '2' },
    });

    assert.deepEqual(event, {
      schemaVersion: 1,
      event: 'runtime_host_ready',
      rootId: 'a'.repeat(64),
      hostEpoch: 'epoch-1',
      protocol: {
        version: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      },
      composition: { id: 'maka.interactive', revision: '2' },
      listeners: [
        { kind: 'local_ipc', endpoint: '/tmp/maka.sock' },
        {
          kind: 'websocket',
          tls: true,
          host: '0.0.0.0',
          port: 7443,
          path: '/runtime-host',
        },
      ],
    });
    assert.equal(JSON.stringify(event).includes('credential'), false);
  });

  test('registers a Project through the local owner connection', async () => {
    let closed = false;
    let request: unknown;
    const connection = {
      request: async (operation: string, input: unknown) => {
        request = { operation, input };
        return {
          kind: 'project',
          project: {
            id: 'project-1',
            aliases: [],
            name: 'project',
            locationCount: 1,
            archivedAt: null,
            available: true,
          },
        };
      },
      close: async () => {
        closed = true;
      },
    } as unknown as RuntimeHostConnection;
    const output: string[] = [];

    assert.equal(
      await runRuntimeHostProjectCli(
        { kind: 'add', rootPath: '/srv/maka', path: '/work/project' },
        {
          connect: async () => connection,
          write: (value) => output.push(value),
        },
      ),
      0,
    );
    assert.deepEqual(request, {
      operation: 'project.catalog.mutate',
      input: { kind: 'register', path: '/work/project' },
    });
    assert.equal(closed, true);
    assert.equal(
      (JSON.parse(output.join('')) as { project: { id: string } }).project.id,
      'project-1',
    );
  });
});

function presetOptions(
  preset: 'desktop-client' | 'terminal-client',
): RuntimeHostAccessIssueOptions {
  return {
    rootPath: '/srv/maka',
    principalKind: 'remote_owner',
    principalId: preset,
    operationGrants: [],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    preset,
  };
}
