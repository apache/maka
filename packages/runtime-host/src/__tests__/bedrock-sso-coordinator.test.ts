import assert from 'node:assert/strict';
import test from 'node:test';
import { manualBedrockModel } from '@maka/runtime/bedrock-model-discovery';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import {
  HostBedrockSsoCoordinator,
  type BedrockSsoCoordinatorDependencies,
} from '../server/bedrock-sso-coordinator.js';
import type { RuntimeHostResidency } from '../server/host-kernel.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

const NOW = 1_800_000_000_000;
const AUTHORIZATION = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  clientSecretExpiresAt: NOW + 86_400_000,
  deviceCode: 'device-code',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
  verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
  expiresAt: NOW + 600_000,
  intervalSeconds: 1,
} as const;
const SESSION = {
  version: 1 as const,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  clientSecretExpiresAt: NOW + 86_400_000,
  accessToken: 'access-token',
  expiresAt: NOW + 3_600_000,
  refreshToken: 'refresh-token',
  scope: ['sso:account:access'],
};
const MODEL = manualBedrockModel('amazon.nova-pro-v1:0');

function fixture(input?: {
  invalidateBackends?: () => Promise<void>;
  dependencies?: Partial<BedrockSsoCoordinatorDependencies>;
}) {
  let commits = 0;
  let activeResidencies = 0;
  const stores = {
    operations: {
      commitConnectionOnboarding: async () => {
        commits += 1;
        return {
          kind: 'committed',
          snapshot: {
            connections: [
              {
                connectionId: 'bedrock-connection',
                slug: 'amazon-bedrock',
                providerType: 'amazon-bedrock',
              },
            ],
          },
        };
      },
    },
  } as unknown as RuntimePolicyStoresWriter;
  const capabilities = {
    hasService: () => true,
    callService: async () => ({}),
  } as unknown as HostClientCapabilityCoordinator;
  const acquireResidency = () => {
    activeResidencies += 1;
    let released = false;
    return {
      release: () => {
        assert.equal(released, false, 'residency must only be released once');
        released = true;
        activeResidencies -= 1;
      },
    } as RuntimeHostResidency;
  };
  const defaults: BedrockSsoCoordinatorDependencies = {
    startAuthorization: async () => AUTHORIZATION,
    pollAuthorization: async () => SESSION,
    getRoleCredentials: async () => ({
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      sessionToken: 'session-token',
    }),
    discoverModels: async () => [MODEL],
    serializeSession: () => 'serialized-session',
    withFetch: (run) => run(fetch),
  };
  const activation = new RuntimePolicyActivationGate();
  const coordinator = new HostBedrockSsoCoordinator(
    stores,
    activation,
    capabilities,
    acquireResidency,
    input?.invalidateBackends ?? (async () => undefined),
    () => NOW,
    { ...defaults, ...input?.dependencies },
  );
  return {
    coordinator,
    activation,
    commits: () => commits,
    activeResidencies: () => activeResidencies,
  };
}

const START_INPUT = {
  ssoStartUrl: 'https://example.awsapps.com/start',
  ssoRegion: 'us-east-1',
  region: 'us-west-2',
};

function context() {
  return { connectionId: 'desktop-client' } as never;
}

async function waitForAuthenticated(coordinator: HostBedrockSsoCoordinator, attemptId: string) {
  for (let index = 0; index < 100; index += 1) {
    const outcome = await coordinator.handlers['bedrock.sso.login.query']({ attemptId }, context());
    if (outcome.ok && outcome.result.phase === 'authenticated') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`attempt ${attemptId} did not authenticate`);
}

test('concurrent Bedrock starts serialize admission and do not orphan the superseded flow', async () => {
  let starts = 0;
  let concurrentStarts = 0;
  let maxConcurrentStarts = 0;
  let releaseFirst!: () => void;
  const firstStartBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const f = fixture({
    dependencies: {
      startAuthorization: async () => {
        starts += 1;
        concurrentStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
        if (starts === 1) await firstStartBlocked;
        concurrentStarts -= 1;
        return { ...AUTHORIZATION, deviceCode: `device-${starts}` };
      },
      pollAuthorization: async ({ authorization, signal }) => {
        if (authorization.deviceCode === 'device-1') {
          await new Promise<never>((_resolve, reject) => {
            const fail = () =>
              reject(signal?.reason ?? new DOMException('cancelled', 'AbortError'));
            if (signal?.aborted) fail();
            else signal?.addEventListener('abort', fail, { once: true });
          });
        }
        return SESSION;
      },
    },
  });

  const first = f.coordinator.handlers['bedrock.sso.login.start'](
    { attemptId: 'first', ...START_INPUT },
    context(),
  );
  const second = f.coordinator.handlers['bedrock.sso.login.start'](
    { attemptId: 'second', ...START_INPUT },
    context(),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, 'the second device authorization must wait for admission');
  releaseFirst();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  await waitForAuthenticated(f.coordinator, 'second');

  assert.equal(maxConcurrentStarts, 1);
  assert.equal(starts, 2);
  const superseded = await f.coordinator.handlers['bedrock.sso.login.query'](
    { attemptId: 'first' },
    context(),
  );
  assert.equal(superseded.ok, false, 'the cancelled flow must not retain an orphan attempt');
  assert.equal(f.activeResidencies(), 0);
  await f.coordinator.close();
});

test('Bedrock commit holds the activation gate through backend invalidation', async () => {
  let invalidationEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    invalidationEntered = resolve;
  });
  let releaseInvalidation!: () => void;
  const invalidationReleased = new Promise<void>((resolve) => {
    releaseInvalidation = resolve;
  });
  const f = fixture({
    invalidateBackends: async () => {
      invalidationEntered();
      await invalidationReleased;
    },
  });
  const attemptId = 'activation-fence';
  await f.coordinator.handlers['bedrock.sso.login.start']({ attemptId, ...START_INPUT }, context());
  await waitForAuthenticated(f.coordinator, attemptId);
  await f.coordinator.handlers['bedrock.sso.models.fetch'](
    { attemptId, accountId: '123456789012', roleName: 'Developer', manualModelIds: [] },
    context(),
  );
  const commit = f.coordinator.handlers['bedrock.sso.onboarding.commit'](
    { attemptId, enabledModelIds: [MODEL.id] },
    context(),
  );
  await entered;
  let activationRan = false;
  const activation = f.activation.runBackendActivation(async () => {
    activationRan = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(activationRan, false, 'activation must wait until invalidation settles');
  releaseInvalidation();
  assert.equal((await commit).ok, true);
  await activation;
  assert.equal(activationRan, true);
  await f.coordinator.close();
});

test('durable Bedrock commit survives invalidation failure and poisons later activation', async () => {
  let invalidations = 0;
  const f = fixture({
    invalidateBackends: async () => {
      invalidations += 1;
      throw new Error('invalidation failed');
    },
  });
  const attemptId = 'durable-commit';
  await f.coordinator.handlers['bedrock.sso.login.start']({ attemptId, ...START_INPUT }, context());
  await waitForAuthenticated(f.coordinator, attemptId);
  const models = await f.coordinator.handlers['bedrock.sso.models.fetch'](
    { attemptId, accountId: '123456789012', roleName: 'Developer', manualModelIds: [] },
    context(),
  );
  assert.equal(models.ok, true);

  const committed = await f.coordinator.handlers['bedrock.sso.onboarding.commit'](
    { attemptId, enabledModelIds: [MODEL.id] },
    context(),
  );
  assert.deepEqual(committed, {
    ok: true,
    result: { connectionId: 'bedrock-connection', slug: 'amazon-bedrock' },
  });
  assert.equal(f.commits(), 1);
  assert.equal(invalidations, 1);

  const replay = await f.coordinator.handlers['bedrock.sso.onboarding.commit'](
    { attemptId, enabledModelIds: [MODEL.id] },
    context(),
  );
  assert.deepEqual(replay, committed);
  assert.equal(f.commits(), 1, 'a durable result must be replayed without another write');
  await assert.rejects(() => f.activation.runBackendActivation(async () => undefined), /poisoned/);
  assert.equal(f.activeResidencies(), 0);
  await f.coordinator.close();
});
