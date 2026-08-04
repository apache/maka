import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { ClaudeSubscriptionService } from '../oauth/claude-subscription-service.js';

it('opens only an authorization URL issued by the Claude subscription service', async () => {
  const openedUrls: string[] = [];
  const service = new ClaudeSubscriptionService({
    userDataDir: '/unused',
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    credentialStore: {
      getSecret: async () => null,
      setSecret: async () => undefined,
      deleteSecret: async () => undefined,
    },
  });

  assert.equal((await service.openAuthorizationUrl('https://attacker.example')).ok, false);
  assert.deepEqual(openedUrls, []);

  const authorization = await service.getAuthorizationUrl();
  assert.deepEqual(Object.keys(authorization).sort(), ['authRequestId', 'stateHint']);
  assert.deepEqual(await service.openAuthorizationUrl(authorization.authRequestId), { ok: true });
  assert.equal(openedUrls.length, 1);
  assert.equal(new URL(openedUrls[0]!).origin, 'https://claude.com');
});
