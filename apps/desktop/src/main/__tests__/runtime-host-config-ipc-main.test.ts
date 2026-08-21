import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppSettings } from '@maka/core/settings';
import type {
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import { gatherRuntimeHostConfig } from '../runtime-host-config-ipc-main.js';

const CATALOG: ConnectionCatalogSnapshot = {
  revision: 1,
  defaultTarget: {
    connectionId: '00000000-0000-4000-8000-000000000001',
    modelId: 'deepseek-v4-pro',
  },
  connections: [
    {
      connectionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      slug: 'deepseek-main',
      name: 'DeepSeek',
      providerType: 'deepseek',
      enabled: true,
      enabledModelIds: ['deepseek-v4-pro'],
      models: [{ id: 'deepseek-v4-pro' }],
    },
  ],
};

test('Runtime Host config export omits settings secrets unless credentials are selected', async () => {
  let credentialExports = 0;
  const bundle = await gatherRuntimeHostConfig(
    ['settings'],
    {
      client: {
        exportConfigurationCredentials: async () => {
          credentialExports += 1;
          return { credential: null };
        },
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  const settings = bundle.data.settings as Record<string, any>;
  assert.deepEqual(bundle.includedData, ['settings']);
  assert.equal(credentialExports, 0);
  assert.equal('password' in settings.network.proxy, false);
  assert.equal('token' in settings.botChat.channels.telegram, false);
  assert.equal('appSecret' in settings.botChat.channels.telegram, false);
  assert.equal('apiKey' in settings.webSearch.providers.tavily, false);
  assert.equal(settings.network.proxy.host, '127.0.0.1');
});

test('Runtime Host config export reads selected credentials from Host authority', async () => {
  const bundle = await gatherRuntimeHostConfig(
    ['connections', 'settings', 'credentials'],
    {
      client: {
        loadConnectionCatalog: async () => CATALOG,
        exportConfigurationCredentials: async ({ locator }: { locator: CredentialLocator }) => {
          const secret = secretFor(locator);
          return {
            credential:
              secret === null
                ? null
                : {
                    locator,
                    secretBase64: Buffer.from(secret).toString('base64'),
                  },
          };
        },
      },
      appVersion: '0.1.0',
      getSettings: async () => settingsWithSecrets(),
    } as never,
  );

  const settings = bundle.data.settings as Record<string, any>;
  assert.deepEqual(bundle.data.credentials, [
    { slug: 'deepseek-main', kind: 'api_key', value: 'sk-host' },
  ]);
  assert.equal(settings.network.proxy.password, 'proxy-host');
  assert.equal(settings.webSearch.providers.tavily.apiKey, 'tavily-host');
  assert.equal(settings.botChat.channels.telegram.token, 'bot-secret');
});

function settingsWithSecrets(): AppSettings {
  return {
    theme: 'dark',
    network: { proxy: { host: '127.0.0.1', password: 'local-proxy-secret' } },
    botChat: {
      channels: {
        telegram: {
          chatId: '42',
          token: 'bot-secret',
          appSecret: 'app-secret',
        },
      },
    },
    webSearch: {
      providers: { tavily: { apiKey: 'local-tavily-secret' } },
    },
  } as unknown as AppSettings;
}

function secretFor(locator: CredentialLocator): string | null {
  if (locator.scope === 'network_proxy') return 'proxy-host';
  if (locator.scope === 'web_search') return 'tavily-host';
  if (locator.scope === 'connection' && locator.kind === 'api_key') {
    return 'sk-host';
  }
  return null;
}
