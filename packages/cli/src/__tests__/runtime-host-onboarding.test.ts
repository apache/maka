/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import type { RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot } from '@maka/runtime-host/client';
import {
  createRuntimeHostReconnectingConnection,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type ClientCapabilityProvider,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { resolveConnectionModelCatalog } from '@maka/core/model-catalog';
import {
  createRuntimeHostOnboardingSurface,
  projectProviders,
  projectRuntimeHostModelChoices,
} from '../runtime-host-onboarding.js';
import type { OnboardingOAuthInput } from '../pi-tui-contracts.js';

type StoredConnection = Omit<ConnectionCatalogSnapshot['connections'][number], 'catalogEntries'>;

/**
 * Fixtures describe what the Host stores; the Host resolves the catalog before
 * projecting it, so these tests read the entries the same resolution produces.
 */
function catalog(connections: readonly StoredConnection[]): ConnectionCatalogSnapshot {
  return {
    revision: 1,
    defaultTarget: null,
    connections: connections.map((connection) => ({
      ...connection,
      catalogEntries: resolveConnectionModelCatalog({
        ...connection,
        defaultModel: '',
        enabledModelIds: [...connection.enabledModelIds],
        models: [...connection.models],
      }),
    })),
  };
}

const live = {
  connectionId: 'live-id',
  revision: 1,
  slug: 'openai',
  name: 'OpenAI',
  providerType: 'openai',
  enabled: true,
  enabledModelIds: ['gpt-5-mini'],
  models: [{ id: 'gpt-5-mini', displayName: 'GPT-5 Mini' }],
} as const;

const oauthConnectionIdentity = {
  connectionId: 'codex-id',
  slug: 'codex-subscription',
  providerType: 'openai-codex',
} as const;

function oauthProjection(
  attemptId: string,
  phase: 'awaiting_authorization' | 'authenticated' | 'committing' | 'cancelled',
) {
  return { attemptId, connection: oauthConnectionIdentity, phase };
}

function interruptedOAuthRequest(operation: 'oauth.login.start' | 'oauth.login.cancel') {
  return new RuntimeHostRequestInterruptedError(
    operation,
    operation === 'oauth.login.start' ? 'command' : 'control',
    'dispatched',
    'connection_lost',
  );
}

function oauthTestSurface(
  attemptId: string,
  request: (operation: string, input: unknown) => unknown | Promise<unknown>,
  options: { readonly pollIntervalMs?: number; readonly onClose?: () => void } = {},
) {
  const requests: string[] = [];
  const connection = {
    replaceClientCapabilities: async () => ({
      registrationId: 'oauth-registration',
      revision: 1,
    }),
    request: async (operation: string, input: unknown) => {
      requests.push(operation);
      return request(operation, input);
    },
  } as unknown as RuntimeHostConnection;
  const surface = createRuntimeHostOnboardingSurface({} as RuntimeHostConnection, {
    connectOAuth: async () => ({
      connection,
      close: async () => options.onClose?.(),
    }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    createAttemptId: () => attemptId,
  });
  return { requests, surface };
}

function loginWithOAuth(
  surface: ReturnType<typeof oauthTestSurface>['surface'],
  options: {
    readonly signal?: AbortSignal;
    readonly target?: OnboardingOAuthInput['target'];
  } = {},
) {
  return surface.loginOAuth!({
    target: options.target ?? { kind: 'create', providerType: 'openai-codex' },
    signal: options.signal ?? new AbortController().signal,
    onPresentation: () => undefined,
  });
}

/** A physical peer: capabilities belong to this connection, not its reconnect wrapper. */
function oauthPhysicalConnection(
  connectionId: string,
  request: (operation: string, input: { attemptId: string }) => unknown | Promise<unknown>,
  onRegister?: () => Promise<void>,
) {
  const closed = deferred<void>();
  const events: string[] = [];
  let registered = false;
  const connection = {
    rootId: 'oauth-test-root',
    hostEpoch: 'oauth-test-host',
    connectionId,
    selectedProtocol: 0,
    compositionId: 'maka.interactive',
    compositionRevision: '1',
    closed: closed.promise,
    replaceClientCapabilities: async () => {
      events.push('capabilities');
      if (onRegister) await onRegister();
      registered = true;
      return { registrationId: connectionId, revision: 1 };
    },
    request: async (operation: string, input: { attemptId: string }) => {
      events.push(operation);
      if (operation === 'oauth.login.start' && !registered) {
        throw new RuntimeHostOperationError(operation, 'capability_unavailable', 'Not registered');
      }
      return request(operation, input);
    },
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => closed.resolve(),
  } as unknown as RuntimeHostConnection;
  return { connection, events, disconnect: () => closed.resolve() };
}

describe('createRuntimeHostOnboardingSurface', () => {
  for (const action of ['cancel', 'close'] as const) {
    test(`bounds OAuth ${action} while a real reconnecting query waits for an offline Host`, async () => {
      const queryDispatched = deferred<void>();
      const first = oauthPhysicalConnection('first', (operation, { attemptId }) => {
        if (operation === 'oauth.login.start') {
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        assert.equal(operation, 'oauth.login.query');
        first.disconnect();
        queryDispatched.resolve();
        throw new RuntimeHostRequestInterruptedError(
          operation,
          'query',
          'dispatched',
          'connection_lost',
        );
      });
      const connection = await createRuntimeHostReconnectingConnection({
        initialConnection: first.connection,
        connect: (signal) =>
          new Promise<RuntimeHostConnection>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      });
      let closeCalls = 0;
      const options = {
        connectOAuth: async () => ({
          connection,
          close: async () => {
            closeCalls += 1;
            await connection.close();
          },
        }),
        pollIntervalMs: 0,
        requestTimeoutMs: 60_000,
        cancellationTimeoutMs: 20,
        shutdownTimeoutMs: 20,
      };
      const surface = createRuntimeHostOnboardingSurface(connection, options);
      const abort = new AbortController();
      const login = loginWithOAuth(surface, { signal: abort.signal });
      try {
        await queryDispatched.promise;
        if (action === 'cancel') abort.abort();
        const closing = action === 'close' ? surface.close() : Promise.resolve();
        const [result] = await withTimeout(
          Promise.all([login, closing]),
          500,
          `OAuth ${action} did not settle while the Host was offline`,
        );
        assert.deepEqual(result, { kind: 'unconfirmed' });
        assert.equal(closeCalls, 1);
        await connection.closed;
      } finally {
        await connection.close();
        await login;
        await surface.close();
      }
    });
  }

  test('waits for the replacement OAuth capability acknowledgement before retrying start', async () => {
    const starts: string[] = [];
    const registration = deferred<void>();
    const queried = deferred<void>();
    const first = oauthPhysicalConnection('first', (operation, { attemptId }) => {
      starts.push(attemptId);
      first.disconnect();
      assert.equal(operation, 'oauth.login.start');
      throw interruptedOAuthRequest(operation);
    });
    const replacement = oauthPhysicalConnection(
      'replacement',
      (operation, { attemptId }) => {
        if (operation === 'oauth.login.query') {
          queried.resolve();
          throw new RuntimeHostOperationError(operation, 'not_found', 'Not admitted');
        }
        starts.push(attemptId);
        return oauthProjection(attemptId, 'authenticated');
      },
      () => registration.promise,
    );
    const connection = await createRuntimeHostReconnectingConnection({
      initialConnection: first.connection,
      connect: async () => replacement.connection,
    });
    const surface = createRuntimeHostOnboardingSurface(connection, {
      connectOAuth: async () => ({ connection, close: () => connection.close() }),
      createAttemptId: () => 'reconnected-start',
    });
    const login = loginWithOAuth(surface);
    try {
      await withTimeout(queried.promise, 500, 'Replacement was not queried');
      assert.ok(!replacement.events.includes('oauth.login.start'));
      registration.resolve();
      assert.deepEqual(await login, {
        kind: 'authenticated',
        connection: oauthConnectionIdentity,
      });
      assert.deepEqual(starts, ['reconnected-start', 'reconnected-start']);
      assert.ok(
        replacement.events.indexOf('capabilities') <
          replacement.events.indexOf('oauth.login.start'),
      );
      assert.equal(replacement.events.filter((event) => event === 'oauth.login.start').length, 1);
    } finally {
      registration.resolve();
      await surface.close();
      await connection.close();
    }
  });

  test('survives another disconnect while publishing the replacement OAuth capability', async () => {
    const first = oauthPhysicalConnection('first', (operation) => {
      first.disconnect();
      assert.equal(operation, 'oauth.login.start');
      throw interruptedOAuthRequest(operation);
    });
    const unstable = oauthPhysicalConnection(
      'unstable',
      (operation) => {
        assert.equal(operation, 'oauth.login.query');
        throw new RuntimeHostOperationError(operation, 'not_found', 'Not admitted');
      },
      async () => {
        unstable.disconnect();
        throw new RuntimeHostRequestInterruptedError(
          'client.capability.replace',
          'control',
          'dispatched',
          'connection_lost',
        );
      },
    );
    const replacement = oauthPhysicalConnection('replacement', (operation, { attemptId }) => {
      if (operation === 'oauth.login.query') {
        throw new RuntimeHostOperationError(operation, 'not_found', 'Not admitted');
      }
      return oauthProjection(attemptId, 'authenticated');
    });
    let reconnects = 0;
    const connection = await createRuntimeHostReconnectingConnection({
      initialConnection: first.connection,
      connect: async () => (++reconnects === 1 ? unstable.connection : replacement.connection),
    });
    const surface = createRuntimeHostOnboardingSurface(connection, {
      connectOAuth: async () => ({ connection, close: () => connection.close() }),
    });
    try {
      assert.equal((await loginWithOAuth(surface)).kind, 'authenticated');
      assert.ok(!unstable.events.includes('oauth.login.start'));
      assert.ok(
        replacement.events.indexOf('capabilities') <
          replacement.events.indexOf('oauth.login.start'),
      );
    } finally {
      await surface.close();
      await connection.close();
    }
  });

  for (const blockedOperation of [
    'oauth.login.start',
    'oauth.login.query',
    'oauth.login.cancel',
  ] as const) {
    test(`retains the attempt and exact target after ${blockedOperation} times out`, async () => {
      const blocked = deferred<never>();
      const started = deferred<void>();
      const abort = new AbortController();
      const requests: Array<{ operation: string; attemptId: string }> = [];
      const target = {
        kind: 'create',
        providerType: 'openai-codex',
        name: 'Work Codex',
        slug: 'codex-work',
      } as const;
      let connections = 0;
      let ids = 0;
      let closes = 0;
      const surface = createRuntimeHostOnboardingSurface({} as RuntimeHostConnection, {
        connectOAuth: async () => {
          const ordinal = ++connections;
          const physical = oauthPhysicalConnection(`physical-${ordinal}`, (operation, input) => {
            requests.push({ operation, attemptId: input.attemptId });
            if (ordinal === 1) {
              if (operation === 'oauth.login.start') {
                assert.deepEqual(input, { attemptId: 'attempt-1', target });
                started.resolve();
              }
              if (operation === blockedOperation) return blocked.promise;
              return oauthProjection(input.attemptId, 'awaiting_authorization');
            }
            assert.equal(operation, 'oauth.login.query');
            return {
              ...oauthProjection(input.attemptId, 'authenticated'),
              connection: { ...oauthConnectionIdentity, slug: 'codex-work' },
            };
          });
          return {
            connection: physical.connection,
            close: async () => {
              closes += 1;
              await physical.connection.close();
            },
          };
        },
        createAttemptId: () => `attempt-${++ids}`,
        pollIntervalMs: 0,
        requestTimeoutMs: 20,
        cancellationTimeoutMs: 20,
      });
      try {
        const login = loginWithOAuth(surface, { signal: abort.signal, target });
        if (blockedOperation === 'oauth.login.cancel') {
          await started.promise;
          abort.abort();
        }
        assert.deepEqual(await withTimeout(login, 500, 'OAuth request remained pending'), {
          kind: 'unconfirmed',
        });
        assert.deepEqual(await loginWithOAuth(surface, { target, signal: AbortSignal.abort() }), {
          kind: 'unconfirmed',
        });
        assert.deepEqual(await loginWithOAuth(surface, { target }), {
          kind: 'authenticated',
          connection: { ...oauthConnectionIdentity, slug: 'codex-work' },
        });
        assert.equal(ids, 1);
        assert.equal(closes, 2);
        assert.ok(requests.every(({ attemptId }) => attemptId === 'attempt-1'));
        assert.equal(
          requests.filter(({ operation }) => operation === 'oauth.login.start').length,
          1,
        );
      } finally {
        blocked.reject(new Error('Fixture closed'));
        await surface.close();
      }
    });
  }

  test('does not apply the OAuth request timeout to connection acquisition', async () => {
    const connecting = deferred<{ connection: RuntimeHostConnection; close(): Promise<void> }>();
    const entered = deferred<void>();
    const physical = oauthPhysicalConnection('slow', (operation, { attemptId }) => {
      assert.equal(operation, 'oauth.login.start');
      return oauthProjection(attemptId, 'authenticated');
    });
    let closes = 0;
    const surface = createRuntimeHostOnboardingSurface({} as RuntimeHostConnection, {
      connectOAuth: async () => {
        entered.resolve();
        return connecting.promise;
      },
      requestTimeoutMs: 20,
    });
    const login = loginWithOAuth(surface);
    try {
      await entered.promise;
      await assert.rejects(
        withTimeout(login, 60, 'OAuth connection acquisition remained pending'),
        /remained pending/,
      );
      connecting.resolve({
        connection: physical.connection,
        close: async () => {
          closes += 1;
          await physical.connection.close();
        },
      });
      assert.deepEqual(await login, {
        kind: 'authenticated',
        connection: oauthConnectionIdentity,
      });
      assert.equal(closes, 1);
    } finally {
      connecting.resolve({
        connection: physical.connection,
        close: () => physical.connection.close(),
      });
      await surface.close();
    }
  });

  test('shutdown bounds a pending connection and releases it if it arrives late', async () => {
    const connecting = deferred<{ connection: RuntimeHostConnection; close(): Promise<void> }>();
    const entered = deferred<void>();
    const physical = oauthPhysicalConnection('late', () => assert.fail('Must not start OAuth'));
    let closes = 0;
    const surface = createRuntimeHostOnboardingSurface({} as RuntimeHostConnection, {
      connectOAuth: async () => {
        entered.resolve();
        return connecting.promise;
      },
      shutdownTimeoutMs: 20,
    });
    const login = loginWithOAuth(surface);
    await entered.promise;
    await withTimeout(surface.close(), 500, 'Shutdown kept waiting for the connector');
    assert.deepEqual(await login, { kind: 'cancelled' });
    connecting.resolve({
      connection: physical.connection,
      close: async () => {
        closes += 1;
        await physical.connection.close();
      },
    });
    await waitFor(() => closes === 1);
    assert.deepEqual(physical.events, []);
  });

  test('cancelling during capability publication never dispatches OAuth start', async () => {
    const registration = deferred<void>();
    const entered = deferred<void>();
    const abort = new AbortController();
    const physical = oauthPhysicalConnection(
      'first',
      () => assert.fail('Must not start OAuth'),
      async () => {
        entered.resolve();
        await registration.promise;
      },
    );
    const surface = createRuntimeHostOnboardingSurface(physical.connection, {
      connectOAuth: async () => ({
        connection: physical.connection,
        close: () => physical.connection.close(),
      }),
    });
    const login = loginWithOAuth(surface, { signal: abort.signal });
    try {
      await entered.promise;
      abort.abort();
      registration.resolve();
      assert.deepEqual(await login, { kind: 'cancelled' });
      assert.deepEqual(physical.events, ['capabilities']);
    } finally {
      registration.resolve();
      await surface.close();
    }
  });

  test('a slow connection cleanup cannot hide an authenticated result or block shutdown', async () => {
    const cleanup = deferred<void>();
    let closes = 0;
    const physical = oauthPhysicalConnection('first', (_operation, { attemptId }) =>
      oauthProjection(attemptId, 'authenticated'),
    );
    const surface = createRuntimeHostOnboardingSurface(physical.connection, {
      connectOAuth: async () => ({
        connection: physical.connection,
        close: async () => {
          closes += 1;
          await cleanup.promise;
          await physical.connection.close();
        },
      }),
      shutdownTimeoutMs: 20,
    });
    try {
      const result = await withTimeout(
        loginWithOAuth(surface),
        500,
        'Cleanup hid the login result',
      );
      assert.deepEqual(result, { kind: 'authenticated', connection: oauthConnectionIdentity });
      await withTimeout(surface.close(), 500, 'Cleanup blocked shutdown');
      assert.equal(closes, 1);
    } finally {
      cleanup.resolve();
      await physical.connection.closed;
      await surface.close();
    }
  });

  test('an unconfirmed attempt cannot be resumed against a different Host root', async () => {
    const blocked = deferred<never>();
    const first = oauthPhysicalConnection('first', () => blocked.promise);
    const wrongRoot = oauthPhysicalConnection('wrong-root', () =>
      assert.fail('Wrong root was queried'),
    );
    let connections = 0;
    let ids = 0;
    const surface = createRuntimeHostOnboardingSurface(first.connection, {
      connectOAuth: async () => {
        const connection =
          ++connections === 1
            ? first.connection
            : { ...wrongRoot.connection, rootId: 'another-root' };
        return { connection, close: () => connection.close() };
      },
      createAttemptId: () => `attempt-${++ids}`,
      requestTimeoutMs: 20,
    });
    try {
      assert.deepEqual(await loginWithOAuth(surface), { kind: 'unconfirmed' });
      assert.deepEqual(await loginWithOAuth(surface), { kind: 'unconfirmed' });
      assert.equal(ids, 1);
      assert.deepEqual(wrongRoot.events, []);
    } finally {
      blocked.reject(new Error('Fixture closed'));
      await surface.close();
    }
  });

  test('reopening setup during cancellation observes the original commit instead of starting again', async () => {
    const started = deferred<void>();
    const queried = deferred<void>();
    const committed = deferred<ReturnType<typeof oauthProjection>>();
    const abort = new AbortController();
    let starts = 0;
    let ids = 0;
    const physical = oauthPhysicalConnection('first', (operation, { attemptId }) => {
      if (operation === 'oauth.login.start') {
        starts += 1;
        started.resolve();
        return oauthProjection(attemptId, 'awaiting_authorization');
      }
      if (operation === 'oauth.login.cancel') return oauthProjection(attemptId, 'committing');
      queried.resolve();
      return committed.promise;
    });
    const surface = createRuntimeHostOnboardingSurface(physical.connection, {
      connectOAuth: async () => ({
        connection: physical.connection,
        close: () => physical.connection.close(),
      }),
      createAttemptId: () => `attempt-${++ids}`,
      pollIntervalMs: 0,
    });
    const first = loginWithOAuth(surface, { signal: abort.signal });
    try {
      await started.promise;
      abort.abort();
      await queried.promise;
      const reopened = loginWithOAuth(surface);
      committed.resolve(oauthProjection('attempt-1', 'authenticated'));
      const expected = { kind: 'authenticated', connection: oauthConnectionIdentity };
      assert.deepEqual(await first, expected);
      assert.deepEqual(await reopened, expected);
      assert.equal(starts, 1);
      assert.equal(ids, 1);
    } finally {
      committed.resolve(oauthProjection('attempt-1', 'authenticated'));
      await surface.close();
    }
  });

  test('asks the Host enrollment gate before offering Codex OAuth', async () => {
    const operations: string[] = [];
    const connection = {
      request: async (operation: string) => {
        operations.push(operation);
        if (operation === 'connection.catalog.query') {
          return {
            kind: 'page',
            revision: 1,
            defaultTarget: null,
            connectionCount: 0,
            items: [],
            nextCursor: null,
          };
        }
        if (operation === 'oauth.enrollment.query') {
          return { provider: 'openai-codex', enabled: true };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;

    const providers = await createRuntimeHostOnboardingSurface(connection).listProviders();

    assert.deepEqual(operations, ['connection.catalog.query', 'oauth.enrollment.query']);
    assert.equal(
      providers.some(
        ({ providerType, target }) => providerType === 'openai-codex' && target.kind === 'create',
      ),
      true,
    );
  });

  test('runs presentation and polling behind one OAuth login call', async () => {
    const requests: string[] = [];
    const presentations: Array<{ readonly url: string; readonly stateHint?: string }> = [];
    let provider: ClientCapabilityProvider | undefined;
    let closeCalls = 0;
    const oauthConnection = {
      replaceClientCapabilities: async (next: ClientCapabilityProvider) => {
        provider = next;
        return { registrationId: 'oauth-registration', revision: 1 };
      },
      request: async (operation: string) => {
        requests.push(operation);
        const connection = {
          connectionId: 'codex-id',
          slug: 'codex-subscription',
          providerType: 'openai-codex' as const,
        };
        if (operation === 'oauth.login.start') {
          assert.ok(provider?.callService);
          await provider.callService(
            {
              kind: 'client.capability.service_call',
              invocationId: 'presentation-1',
              registrationId: 'oauth-registration',
              serviceId: 'oauth_presentation',
              version: '1',
              method: 'open_external',
              input: {
                url: 'https://auth.openai.com/codex/device',
                stateHint: 'ABCD-EFGH',
              },
            },
            {
              signal: new AbortController().signal,
              accept: async () => undefined,
            },
          );
          return {
            attemptId: 'setup-oauth-1',
            connection,
            phase: 'awaiting_authorization',
          };
        }
        if (operation === 'oauth.login.query') {
          return { attemptId: 'setup-oauth-1', connection, phase: 'authenticated' };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;
    const surface = createRuntimeHostOnboardingSurface({} as RuntimeHostConnection, {
      connectOAuth: async () => ({
        connection: oauthConnection,
        close: async () => {
          closeCalls += 1;
        },
      }),
      pollIntervalMs: 0,
      createAttemptId: () => 'setup-oauth-1',
    });

    const result = await surface.loginOAuth?.({
      target: { kind: 'create', providerType: 'openai-codex' },
      signal: new AbortController().signal,
      onPresentation: (presentation) => presentations.push(presentation),
    });

    assert.deepEqual(result, {
      kind: 'authenticated',
      connection: {
        connectionId: 'codex-id',
        slug: 'codex-subscription',
        providerType: 'openai-codex',
      },
    });
    assert.deepEqual(presentations, [
      { url: 'https://auth.openai.com/codex/device', stateHint: 'ABCD-EFGH' },
    ]);
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.query']);
    assert.equal(closeCalls, 1);
  });

  test('reconciles a dispatched OAuth start after its response is lost', async () => {
    const attemptId = 'setup-oauth-dispatched-start';
    const { requests, surface } = oauthTestSurface(attemptId, (operation) => {
      if (operation === 'oauth.login.start') throw interruptedOAuthRequest(operation);
      if (operation === 'oauth.login.query') return oauthProjection(attemptId, 'authenticated');
      throw new Error(`Unexpected operation ${operation}`);
    });

    const result = await loginWithOAuth(surface);

    assert.deepEqual(result, {
      kind: 'authenticated',
      connection: oauthConnectionIdentity,
    });
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.query']);
  });

  test('retries the same OAuth start when reconciliation proves it was not admitted', async () => {
    const attemptId = 'setup-oauth-retried-start';
    let startCalls = 0;
    const { requests, surface } = oauthTestSurface(attemptId, (operation) => {
      if (operation === 'oauth.login.start') {
        startCalls += 1;
        if (startCalls === 1) {
          throw interruptedOAuthRequest(operation);
        }
        return oauthProjection(attemptId, 'authenticated');
      }
      if (operation === 'oauth.login.query') {
        throw new RuntimeHostOperationError(
          'oauth.login.query',
          'not_found',
          'OAuth login was not found',
        );
      }
      throw new Error(`Unexpected operation ${operation}`);
    });

    assert.equal((await loginWithOAuth(surface)).kind, 'authenticated');
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.query', 'oauth.login.start']);
  });

  test('reconciles a dispatched OAuth cancellation instead of trusting the local signal', async () => {
    const attemptId = 'setup-oauth-dispatched-cancel';
    const started = deferred<void>();
    const controller = new AbortController();
    const { requests, surface } = oauthTestSurface(
      attemptId,
      (operation) => {
        if (operation === 'oauth.login.start') {
          started.resolve();
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        if (operation === 'oauth.login.cancel') throw interruptedOAuthRequest(operation);
        if (operation === 'oauth.login.query') return oauthProjection(attemptId, 'authenticated');
        throw new Error(`Unexpected operation ${operation}`);
      },
      { pollIntervalMs: 60_000 },
    );

    const login = loginWithOAuth(surface, { signal: controller.signal });
    await started.promise;
    controller.abort();

    assert.deepEqual(await login, {
      kind: 'authenticated',
      connection: oauthConnectionIdentity,
    });
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.cancel', 'oauth.login.query']);
  });

  test('retries cancellation when reconciliation still finds an active OAuth attempt', async () => {
    const attemptId = 'setup-oauth-retried-cancel';
    const started = deferred<void>();
    const controller = new AbortController();
    let cancelCalls = 0;
    const { requests, surface } = oauthTestSurface(
      attemptId,
      (operation) => {
        if (operation === 'oauth.login.start') {
          started.resolve();
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        if (operation === 'oauth.login.cancel') {
          cancelCalls += 1;
          if (cancelCalls === 1) throw interruptedOAuthRequest(operation);
          return oauthProjection(attemptId, 'cancelled');
        }
        if (operation === 'oauth.login.query') {
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
      { pollIntervalMs: 60_000 },
    );

    const login = loginWithOAuth(surface, { signal: controller.signal });
    await started.promise;
    controller.abort();

    assert.deepEqual(await login, { kind: 'cancelled' });
    assert.deepEqual(requests, [
      'oauth.login.start',
      'oauth.login.cancel',
      'oauth.login.query',
      'oauth.login.cancel',
    ]);
  });

  test('does not mistake a Host cancellation failure for local cancellation', async () => {
    const attemptId = 'setup-oauth-cancel-failed';
    const started = deferred<void>();
    const controller = new AbortController();
    const { surface } = oauthTestSurface(
      attemptId,
      (operation) => {
        if (operation === 'oauth.login.start') {
          started.resolve();
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        throw new RuntimeHostOperationError(
          'oauth.login.cancel',
          'persistence_failed',
          'OAuth cancellation could not be reconciled',
        );
      },
      { pollIntervalMs: 60_000 },
    );

    const login = loginWithOAuth(surface, { signal: controller.signal });
    await started.promise;
    controller.abort();

    assert.deepEqual(await login, { kind: 'unconfirmed' });
  });

  test('preserves a Host slug_taken error as an OAuth failure reason', async () => {
    const { surface } = oauthTestSurface('setup-oauth-slug-taken', () => {
      throw new RuntimeHostOperationError(
        'oauth.login.start',
        'slug_taken',
        'Connection slug is already in use',
      );
    });

    assert.deepEqual(
      await surface.loginOAuth!({
        target: {
          kind: 'create',
          providerType: 'openai-codex',
          slug: 'codex-work',
          name: 'Work Codex',
        },
        signal: new AbortController().signal,
        onPresentation: () => undefined,
      }),
      { kind: 'failed', reason: 'slug_taken' },
    );
  });

  test('forwards the requested Connection identity to OAuth start', async () => {
    const attemptId = 'setup-oauth-custom';
    const target = {
      kind: 'create',
      providerType: 'openai-codex',
      slug: 'codex-work',
      name: 'Work Codex',
    } as const;
    const starts: unknown[] = [];
    const { surface } = oauthTestSurface(attemptId, (operation, input) => {
      assert.equal(operation, 'oauth.login.start');
      starts.push(input);
      return {
        ...oauthProjection(attemptId, 'authenticated'),
        connection: { ...oauthConnectionIdentity, slug: 'codex-work' },
      };
    });

    await loginWithOAuth(surface, { target });

    assert.deepEqual(starts, [{ attemptId, target }]);
  });

  test('closing the onboarding surface cancels and settles its active OAuth attempt', async () => {
    const attemptId = 'setup-oauth-close';
    const started = deferred<void>();
    let closeCalls = 0;
    const { requests, surface } = oauthTestSurface(
      attemptId,
      (operation) => {
        if (operation === 'oauth.login.start') {
          started.resolve();
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        if (operation === 'oauth.login.cancel') return oauthProjection(attemptId, 'cancelled');
        throw new Error(`Unexpected operation ${operation}`);
      },
      {
        pollIntervalMs: 60_000,
        onClose: () => {
          closeCalls += 1;
        },
      },
    );
    const login = loginWithOAuth(surface);
    await started.promise;

    await surface.close();

    assert.deepEqual(await login, { kind: 'cancelled' });
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.cancel']);
    assert.equal(closeCalls, 1);
  });

  test('accepts authentication when cancellation loses the Host commit race', async () => {
    const attemptId = 'setup-oauth-race';
    const started = deferred<void>();
    const abort = new AbortController();
    const { requests, surface } = oauthTestSurface(
      attemptId,
      (operation) => {
        if (operation === 'oauth.login.start') {
          started.resolve();
          return oauthProjection(attemptId, 'awaiting_authorization');
        }
        if (operation === 'oauth.login.cancel') return oauthProjection(attemptId, 'committing');
        if (operation === 'oauth.login.query') return oauthProjection(attemptId, 'authenticated');
        throw new Error(`Unexpected operation ${operation}`);
      },
      { pollIntervalMs: 20 },
    );
    const login = loginWithOAuth(surface, { signal: abort.signal });
    await started.promise;

    abort.abort();

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.cancel']);

    assert.deepEqual(await login, {
      kind: 'authenticated',
      connection: oauthConnectionIdentity,
    });
    assert.deepEqual(requests, ['oauth.login.start', 'oauth.login.cancel', 'oauth.login.query']);
    await surface.close();
  });

  test('preserves Host failure codes without projecting backend text', async () => {
    const connection = {
      request: async (operation: string) => {
        if (operation === 'connection.onboarding.verify') {
          return { kind: 'rejected', reason: 'connection_not_found' };
        }
        if (operation === 'connection.onboarding.save') {
          return { kind: 'failed', errorClass: 'network' };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;
    const surface = createRuntimeHostOnboardingSurface(connection);

    assert.deepEqual(
      await surface.verify({
        target: { kind: 'existing', connectionId: 'gone-id' },
        apiKey: 'sk-test',
      }),
      { kind: 'rejected', reason: 'connection_not_found' },
    );
    assert.deepEqual(
      await surface.save({
        target: { kind: 'existing', connectionId: 'live-id' },
        apiKey: 'sk-test',
        enabledModelIds: ['gpt-5-mini'],
      }),
      { kind: 'failed', errorClass: 'network' },
    );
  });

  test('classifies transport exceptions without exposing their message', async () => {
    const connection = {
      request: async () => {
        throw new Error('Host transport leaked this English detail');
      },
    } as unknown as RuntimeHostConnection;

    assert.deepEqual(
      await createRuntimeHostOnboardingSurface(connection).verify({
        target: { kind: 'create', providerType: 'openai' },
        apiKey: 'sk-test',
      }),
      { kind: 'unavailable' },
    );
  });

  test('keeps the committed Connection when the follow-up catalog refresh fails', async () => {
    const committed = {
      connectionId: 'committed-openai-id',
      revision: 3,
      slug: 'openai-2',
      providerType: 'openai',
    } as const;
    const connection = {
      request: async (operation: string) => {
        if (operation === 'connection.onboarding.save') {
          return { kind: 'saved', connection: committed };
        }
        if (operation === 'connection.catalog.query') {
          throw new Error('transient catalog failure');
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;

    const result = await createRuntimeHostOnboardingSurface(connection).save({
      target: { kind: 'create', providerType: 'openai' },
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5-mini'],
    });

    assert.deepEqual(result, {
      kind: 'ok',
      connection: committed,
      refresh: {
        kind: 'failed',
        reason: 'catalog_unavailable',
      },
    });
  });
});

describe('projectRuntimeHostModelChoices', () => {
  test('a retained retired connection contributes no /model choices', () => {
    // Retirement keeps the connection enabled so its credential stays visible
    // and deletable. Filtering on `enabled` alone listed its models here and
    // only refused them after the user picked one.
    const choices = projectRuntimeHostModelChoices(
      catalog([
        live,
        {
          ...live,
          connectionId: 'retired-id',
          slug: 'claude-subscription',
          name: 'Claude Subscription',
          providerType: 'claude-subscription',
          enabledModelIds: ['claude-opus-5'],
          models: [{ id: 'claude-opus-5' }],
        },
      ]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug, model }) => ({ connectionSlug, model })),
      [{ connectionSlug: 'openai', model: 'gpt-5-mini' }],
    );
  });

  test('a disabled connection is also excluded, so the filter is not over-broad', () => {
    const choices = projectRuntimeHostModelChoices(
      catalog([live, { ...live, connectionId: 'off-id', slug: 'openai-off', enabled: false }]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug }) => connectionSlug),
      ['openai'],
    );
  });

  test('projects the catalog display name onto each model choice', () => {
    const choices = projectRuntimeHostModelChoices(catalog([live]));

    assert.equal(choices[0]?.displayName, 'GPT-5 Mini');
  });

  test('a model that exists only in the resolved catalog still carries its context window', () => {
    // A provider with no model-list endpoint stores no rows, so its models are
    // reachable only through the Host's resolved catalog. The TUI reads its
    // opening context window from these choices for exactly this reason: the
    // stored list it used to read is empty here, and the very first status
    // line would have had no denominator.
    const choices = projectRuntimeHostModelChoices(
      catalog([
        {
          connectionId: 'fallback-id',
          revision: 1,
          slug: 'codex',
          name: 'Codex',
          providerType: 'openai-codex',
          enabled: true,
          enabledModelIds: ['gpt-5.5'],
          models: [],
        },
      ]),
    );

    assert.ok(choices.length > 0, 'a fallback-only connection still offers models');
    for (const choice of choices) {
      assert.equal(
        typeof choice.contextWindow,
        'number',
        `${choice.model} reached the picker without a context window`,
      );
    }
  });
});

describe('projectProviders', () => {
  const relay = {
    connectionId: 'relay-custom-id',
    revision: 1,
    slug: 'my-relay',
    name: 'My Relay',
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    enabled: true,
    enabledModelIds: ['relay/model'],
    models: [{ id: 'relay/model' }],
  } as const;

  test('enabled Codex OAuth projects existing accounts and one add-account row', () => {
    const codex = {
      connectionId: 'codex-id',
      revision: 1,
      slug: 'codex-subscription',
      name: 'Work Codex',
      providerType: 'openai-codex',
      enabled: true,
      enabledModelIds: ['gpt-5.5'],
      models: [],
    } as const;

    const entries = projectProviders(catalog([codex]), true).filter(
      ({ providerType }) => providerType === 'openai-codex',
    );

    assert.deepEqual(entries, [
      {
        providerType: 'openai-codex',
        label: 'Work Codex · codex-subscription',
        requiresBaseUrl: false,
        setupMethod: 'oauth',
        target: { kind: 'existing', connectionId: 'codex-id' },
        connectionSlug: 'codex-subscription',
        enabledModelIds: ['gpt-5.5'],
      },
      {
        providerType: 'openai-codex',
        label: 'OpenAI OAuth (ChatGPT / Codex)',
        requiresBaseUrl: false,
        setupMethod: 'oauth',
        target: { kind: 'create', providerType: 'openai-codex' },
        suggestedSlug: 'codex-subscription-2',
        enabledModelIds: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      },
    ]);
  });

  test('a Desktop-created relay and add-account action are both explicit', () => {
    const entries = projectProviders(catalog([relay])).filter(
      ({ providerType }) => providerType === 'openai-compatible',
    );
    const entry = entries.find(({ target }) => target.kind === 'existing');
    assert.deepEqual(entry?.target, { kind: 'existing', connectionId: 'relay-custom-id' });
    assert.equal(entry && 'connectionSlug' in entry ? entry.connectionSlug : undefined, 'my-relay');
    assert.deepEqual(entry?.enabledModelIds, ['relay/model']);
    assert.deepEqual(entries.find(({ target }) => target.kind === 'create')?.target, {
      kind: 'create',
      providerType: 'openai-compatible',
    });
    assert.equal(
      entries.find(({ target }) => target.kind === 'create')?.label,
      'Custom relay (OpenAI Chat-compatible)',
    );
  });

  test('several non-canonical connections remain independently editable', () => {
    const entries = projectProviders(
      catalog([relay, { ...relay, connectionId: 'relay-2-id', slug: 'my-relay-2' }]),
    ).filter(({ providerType }) => providerType === 'openai-compatible');
    assert.deepEqual(
      entries.flatMap(({ target }) => (target.kind === 'existing' ? [target.connectionId] : [])),
      ['relay-custom-id', 'relay-2-id'],
    );
  });

  test('the create row carries the Host-derived slug suggestion for the identity step', () => {
    const taken = {
      ...relay,
      connectionId: 'openai-id',
      slug: 'openai',
      providerType: 'openai' as const,
    };
    const entries = projectProviders(catalog([taken])).filter(
      ({ providerType }) => providerType === 'openai',
    );
    const create = entries.find(({ target }) => target.kind === 'create');
    assert.equal(
      create && 'suggestedSlug' in create ? create.suggestedSlug : undefined,
      'openai-2',
    );
    // …and with no existing connection the suggestion is the canonical base.
    const bare = projectProviders(catalog([])).find(
      ({ providerType }) => providerType === 'openai',
    );
    assert.equal(bare && 'suggestedSlug' in bare ? bare.suggestedSlug : undefined, 'openai');
  });

  test('a canonical connection does not hide another account', () => {
    const canonical = { ...relay, connectionId: 'canonical-id', slug: 'openai-compatible' };
    const entries = projectProviders(catalog([relay, canonical])).filter(
      ({ providerType, target }) =>
        providerType === 'openai-compatible' && target.kind === 'existing',
    );
    assert.deepEqual(
      entries.flatMap(({ target }) => (target.kind === 'existing' ? [target.connectionId] : [])),
      ['relay-custom-id', 'canonical-id'],
    );
  });
});
